import { resolve, dirname } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import checkpoints from '../bot/checkpoint-store.cjs'

const { readCheckpoint, writeCheckpoint, acquireLocalLease } = checkpoints
const queues = new Map()
// Published standard USD rates, expressed as nanodollars per token.
const prices = {
  'claude-sonnet-5-5': { input: 2000, output: 10000, cacheRead: 100, cache5m: 2500, cache1h: 4000 },
  'claude-sonnet-4-6': { input: 3000, output: 15000, cacheRead: 300, cache5m: 3750, cache1h: 6000 }
}
const count = value => Number.isSafeInteger(value) && value >= 0
const exhausted = () => Error('Agent API budget exhausted. Existing tasks are preserved; ask the host owner to approve more credit.')

export function usdToNano(value) {
  const text = String(value)
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw Error('INVALID_ANTHROPIC_BUDGET')
  const [whole, fraction = ''] = text.split('.')
  const result = Number(BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')))
  if (!count(result)) throw Error('INVALID_ANTHROPIC_BUDGET')
  return result
}

function terms(budget) {
  if (!budget || typeof budget.file !== 'string' || !budget.file || !/^[A-Za-z0-9_-]{1,100}$/.test(budget.authorizationId || '')) throw Error('ANTHROPIC_BUDGET_REQUIRED')
  const limitNanoUsd = usdToNano(budget.limitUsd)
  if (!limitNanoUsd) throw Error('ANTHROPIC_BUDGET_REQUIRED')
  return { ...budget, file: resolve(budget.file), limitNanoUsd }
}

function validate(state, budget) {
  if (!state || state.version !== 1 || state.authorizationId !== budget.authorizationId || state.limitNanoUsd !== budget.limitNanoUsd ||
      !count(state.spentNanoUsd) || !count(state.completedRequests) || !state.pending || Array.isArray(state.pending) || typeof state.pending !== 'object' ||
      Object.values(state.pending).some(value => !count(value.ceilingNanoUsd) || !value.ceilingNanoUsd)) throw Error('ANTHROPIC_BUDGET_STATE_INVALID_OR_MISSING')
  const committed = state.spentNanoUsd + Object.values(state.pending).reduce((sum, value) => sum + value.ceilingNanoUsd, 0)
  if (!count(committed) || committed > budget.limitNanoUsd) throw Error('ANTHROPIC_BUDGET_STATE_INVALID_OR_MISSING')
  return committed
}

async function mutate(configuration, change, persist = true) {
  const budget = terms(configuration)
  // shortcut: the OS lease fences one host; use shared transactional storage before multi-host inference.
  const work = (queues.get(budget.file) || Promise.resolve()).then(async () => {
    const release = await acquireLocalLease('anthropic-budget:' + budget.file)
    try {
      const state = await readCheckpoint(budget.file)
      validate(state, budget)
      const result = await change(state, budget)
      if (persist) await writeCheckpoint(budget.file, state)
      return result
    } finally { await release() }
  })
  queues.set(budget.file, work.catch(() => {}))
  return work
}

export async function initializeAnthropicBudget(configuration, initialSpentUsd = '0') {
  const budget = terms(configuration), spentNanoUsd = usdToNano(initialSpentUsd)
  if (spentNanoUsd > budget.limitNanoUsd) throw Error('INVALID_ANTHROPIC_BUDGET')
  await mkdir(dirname(budget.file), { recursive: true, mode: 0o700 })
  const release = await acquireLocalLease('anthropic-budget:' + budget.file)
  try {
    const exists = await stat(budget.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (exists) { validate(await readCheckpoint(budget.file), budget); return }
    await writeCheckpoint(budget.file, { version: 1, authorizationId: budget.authorizationId, limitNanoUsd: budget.limitNanoUsd,
      initialSpentNanoUsd: spentNanoUsd, spentNanoUsd, completedRequests: 0, pending: {}, createdAt: new Date().toISOString() })
  } finally { await release() }
}

export async function validateAnthropicBudget(budget, model) {
  if (!prices[model]) throw Error('ANTHROPIC_BUDGET_MODEL_UNSUPPORTED')
  await mutate(budget, () => {}, false)
}

export async function reserveAnthropicRequest(provider, body) {
  if (!provider.budget) return null
  const rates = prices[provider.model]
  if (!rates) throw Error('ANTHROPIC_BUDGET_MODEL_UNSUPPORTED')
  const { max_tokens, stream, ...counter } = body
  const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2026-10-21' }, body: JSON.stringify(counter)
  })
  if (!response.ok) throw Error('ANTHROPIC_TOKEN_COUNT_HTTP_' + response.status)
  const inputTokens = (await response.json()).input_tokens
  if (!count(inputTokens) || !inputTokens || inputTokens > 32000) throw Error('ANTHROPIC_TOKEN_COUNT_INVALID_OR_TOO_LARGE')
  const inputBound = inputTokens * 2 + 1000
  const ceilingNanoUsd = inputBound * rates.cache1h + max_tokens * rates.output
  if (!count(ceilingNanoUsd) || !ceilingNanoUsd) throw Error('ANTHROPIC_TOKEN_COUNT_INVALID')
  return mutate(provider.budget, (state, budget) => {
    if (state.blockedReason) throw Error('Agent compute budget needs operator reconciliation before more requests.')
    if (validate(state, budget) + ceilingNanoUsd > budget.limitNanoUsd) throw exhausted()
    const id = randomUUID()
    state.pending[id] = { model: provider.model, inputBound, maxTokens: max_tokens, ceilingNanoUsd, createdAt: new Date().toISOString() }
    return id
  })
}

export async function recordAnthropicUsage(provider, id, body, requestId) {
  if (!id) return
  const result = await mutate(provider.budget, state => {
    const pending = state.pending[id], usage = body.usage
    if (!pending) throw Error('ANTHROPIC_BUDGET_REQUEST_NOT_PENDING')
    const values = [usage?.input_tokens, usage?.output_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0]
    if (body.model !== pending.model || values.some(value => !count(value)) || values[0] + values[2] + values[3] > pending.inputBound || values[1] > pending.maxTokens) {
      state.blockedReason = 'Provider usage did not match the reserved model/token bounds.'
      return false
    }
    const rates = prices[pending.model], [input, output, read, created] = values
    const five = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0, hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const creationCost = count(five) && count(hour) && five + hour === created ? five * rates.cache5m + hour * rates.cache1h : created * rates.cache1h
    const costNanoUsd = input * rates.input + output * rates.output + read * rates.cacheRead + creationCost
    if (!count(costNanoUsd) || costNanoUsd > pending.ceilingNanoUsd) {
      state.blockedReason = 'Provider cost exceeded the reserved ceiling.'
      return false
    }
    state.spentNanoUsd += costNanoUsd
    state.completedRequests++
    state.lastReceipt = { reservationId: id, responseId: body.id, requestId, model: body.model, usage, costNanoUsd, recordedAt: new Date().toISOString() }
    delete state.pending[id]
    return true
  })
  if (!result) throw Error('Agent compute budget needs operator reconciliation before more requests.')
}
