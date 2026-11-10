import { resolve, dirname } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import checkpoints from '../bot/checkpoint-store.cjs'

const { readCheckpoint, writeCheckpoint, acquireLocalLease } = checkpoints
const queues = new Map()
const count = value => Number.isSafeInteger(value) && value >= 0
export const zeroGModel = Object.freeze({ model: 'glm-4.7', inputNanoUsd: 900, outputNanoUsd: 3300, contextTokens: 204800 })
// Fractional nanodollar rates are rounded upward to keep the shared ledger conservative.
export const zeroGEconomyModel = Object.freeze({model:'qwen3.5-35b-a3b',inputNanoUsd:59,outputNanoUsd:467,contextTokens:262144})
export const zeroGModels = Object.freeze({[zeroGModel.model]:zeroGModel,[zeroGEconomyModel.model]:zeroGEconomyModel})
export const zeroGSpeechModels = Object.freeze({
  'whisper-large-v3': { unit: 'second', unitNanoUsd: 130000, maxUnits: 12 },
  'minimax-speech-2.8-turbo': { unit: 'character', unitNanoUsd: 108000, maxUnits: 2000 }
})
const validAudio = value => value.kind === 'audio' && Boolean(zeroGSpeechModels[value.model]) &&
  count(value.units) && value.units > 0 && value.units <= zeroGSpeechModels[value.model].maxUnits &&
  value.unit === zeroGSpeechModels[value.model].unit && value.unitNanoUsd === zeroGSpeechModels[value.model].unitNanoUsd &&
  value.ceilingNanoUsd === value.units * value.unitNanoUsd && value.source === 'https://router-api.0g.ai/v1/models' &&
  Number.isFinite(Date.parse(value.observedAt)) && /^[a-f0-9]{64}$/.test(value.requestSha256 || '')
const validPricing = value => Boolean(zeroGModels[value?.model]) && value.inputNanoUsd === zeroGModels[value.model].inputNanoUsd &&
  value.outputNanoUsd === zeroGModels[value.model].outputNanoUsd && value.contextTokens === zeroGModels[value.model].contextTokens &&
  value.source === 'https://router-api.0g.ai/v1/models' && Number.isFinite(Date.parse(value.observedAt))

function usdToNano(value) {
  const text = String(value)
  if (!/^\d+(?:\.\d{1,9})?$/.test(text)) throw Error('INVALID_ZERO_G_BUDGET')
  const [whole, fraction = ''] = text.split('.')
  const result = Number(BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, '0')))
  if (!count(result)) throw Error('INVALID_ZERO_G_BUDGET')
  return result
}

function terms(budget) {
  if (!budget || typeof budget.file !== 'string' || !budget.file ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(budget.authorizationId || '')) throw Error('ZERO_G_BUDGET_REQUIRED')
  const limitNanoUsd = usdToNano(budget.limitUsd)
  if (!limitNanoUsd || limitNanoUsd > 5000000000) throw Error('ZERO_G_BUDGET_EXCEEDS_AUTHORIZATION')
  return { ...budget, file: resolve(budget.file), limitNanoUsd }
}

function validate(state, budget) {
  if (!state || state.version !== 1 || state.authorizationId !== budget.authorizationId || state.limitNanoUsd !== budget.limitNanoUsd ||
      !count(state.spentNanoUsd) || !count(state.completedRequests) || !state.pending || Array.isArray(state.pending) ||
      typeof state.pending !== 'object' || Object.values(state.pending).some(value =>
        value.kind === 'audio' ? !validAudio(value) : !zeroGModels[value.model] || !validPricing(value.pricing) || value.pricing.model!==value.model || !count(value.ceilingNanoUsd) ||
        value.inputBound !== zeroGModels[value.model].contextTokens || !count(value.maxTokens) || !value.maxTokens || value.maxTokens > 4096 ||
        value.ceilingNanoUsd !== zeroGModels[value.model].contextTokens * zeroGModels[value.model].inputNanoUsd + value.maxTokens * zeroGModels[value.model].outputNanoUsd)) {
    throw Error('ZERO_G_BUDGET_STATE_INVALID_OR_MISSING')
  }
  const committed = state.spentNanoUsd + Object.values(state.pending).reduce((sum, value) => sum + value.ceilingNanoUsd, 0)
  if (!count(committed) || committed > budget.limitNanoUsd) throw Error('ZERO_G_BUDGET_STATE_INVALID_OR_MISSING')
  return committed
}

async function mutate(configuration, change, persist = true) {
  const budget = terms(configuration)
  // shortcut: this durable lease fences one host; use a shared ledger before multi-host inference.
  const work = (queues.get(budget.file) || Promise.resolve()).then(async () => {
    const release = await acquireLocalLease('zero-g-budget:' + budget.file)
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

export async function initializeZeroGBudget(configuration, initialSpentUsd = '0') {
  const budget = terms(configuration), spentNanoUsd = usdToNano(initialSpentUsd)
  if (spentNanoUsd > budget.limitNanoUsd) throw Error('INVALID_ZERO_G_BUDGET')
  await mkdir(dirname(budget.file), { recursive: true, mode: 0o700 })
  const release = await acquireLocalLease('zero-g-budget:' + budget.file)
  try {
    const exists = await stat(budget.file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
    if (exists) { validate(await readCheckpoint(budget.file), budget); return }
    await writeCheckpoint(budget.file, { version: 1, authorizationId: budget.authorizationId, limitNanoUsd: budget.limitNanoUsd,
      initialSpentNanoUsd: spentNanoUsd, spentNanoUsd, completedRequests: 0, pending: {}, createdAt: new Date().toISOString() })
  } finally { await release() }
}

export async function validateZeroGBudget(budget) {
  await mutate(budget, () => {}, false)
}

export async function reserveZeroGAudio(provider, model, units, requestSha256, pricing) {
  const spec = zeroGSpeechModels[model]
  const reservation = { kind: 'audio', model, units, ...spec, source: pricing?.source,
    observedAt: pricing?.observedAt, requestSha256, ceilingNanoUsd: units * spec?.unitNanoUsd }
  if (!validAudio(reservation) || Math.abs(Date.now() - Date.parse(reservation.observedAt)) > 60000 || pricing.unitNanoUsd !== spec.unitNanoUsd) throw Error('INVALID_ZERO_G_AUDIO_BOUND')
  return mutate(provider.budget, (state, budget) => {
    if (state.blockedReason) throw Error('0G budget needs operator reconciliation before more requests.')
    if (validate(state, budget) + reservation.ceilingNanoUsd > budget.limitNanoUsd) throw Error('0G API budget exhausted; existing tasks are preserved.')
    const id = randomUUID(); state.pending[id] = { ...reservation, createdAt: new Date().toISOString() }; return id
  })
}

export async function recordZeroGAudio(provider, id, providerRequestId) {
  return mutate(provider.budget, state => {
    const pending = state.pending[id]
    if (!validAudio(pending || {})) throw Error('ZERO_G_AUDIO_REQUEST_NOT_PENDING')
    // Charge the reserved duration/UTF-8 byte ceiling locally; unknown calls remain reserved.
    state.spentNanoUsd += pending.ceilingNanoUsd; state.completedRequests++
    state.lastReceipt = { model: pending.model, requestId: providerRequestId || null,
      costNanoUsd: pending.ceilingNanoUsd, conservativeCostEstimate: true, units: pending.units,
      unit: pending.unit, requestSha256: pending.requestSha256, recordedAt: new Date().toISOString() }
    delete state.pending[id]; return state.lastReceipt
  })
}

export async function reserveZeroGRequest(provider, request, pricing) {
  if (!zeroGModels[provider.model] || !validPricing(pricing) || pricing.model!==provider.model || Math.abs(Date.now() - Date.parse(pricing.observedAt)) > 60000 || request.model !== provider.model ||
      !count(request.max_tokens) || !request.max_tokens || request.max_tokens > 4096) throw Error('INVALID_ZERO_G_REQUEST_BOUND')
  // Reserve the entire published context, not an optimistic local tokenizer estimate.
  const ceilingNanoUsd = pricing.contextTokens * pricing.inputNanoUsd + request.max_tokens * pricing.outputNanoUsd
  return mutate(provider.budget, (state, budget) => {
    if (state.blockedReason) throw Error('0G budget needs operator reconciliation before more requests.')
    if (validate(state, budget) + ceilingNanoUsd > budget.limitNanoUsd) throw Error('0G API budget exhausted; existing tasks are preserved.')
    const id = randomUUID()
    state.pending[id] = { model: provider.model, inputBound: pricing.contextTokens, maxTokens: request.max_tokens,
      ceilingNanoUsd, pricing, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'), createdAt: new Date().toISOString() }
    return id
  })
}

export async function recordZeroGUsage(provider, id, body, requestId, latencyMs) {
  const result = await mutate(provider.budget, state => {
    const pending = state.pending[id], usage = body?.usage
    if (!pending) throw Error('ZERO_G_BUDGET_REQUEST_NOT_PENDING')
    if (body.model !== pending.model || typeof body.id !== 'string' || !body.id ||
        !count(usage?.prompt_tokens) || !count(usage?.completion_tokens) ||
        usage.prompt_tokens > pending.inputBound || usage.completion_tokens > pending.maxTokens ||
        (usage.total_tokens !== undefined && usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens)) {
      state.blockedReason = 'Provider usage did not match the reserved model/token bounds.'
      return false
    }
    const costNanoUsd = usage.prompt_tokens * pending.pricing.inputNanoUsd + usage.completion_tokens * pending.pricing.outputNanoUsd
    if (!count(costNanoUsd) || costNanoUsd > pending.ceilingNanoUsd) {
      state.blockedReason = 'Provider cost exceeded the reserved ceiling.'
      return false
    }
    state.spentNanoUsd += costNanoUsd
    state.completedRequests++
    state.lastReceipt = { reservationId: id, responseId: body.id, requestId, model: body.model,
      ...(pending.model===zeroGEconomyModel.model?{conservativeCostEstimate:true}:{}),
      usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }, costNanoUsd,
      pricing: pending.pricing, requestSha256: pending.requestSha256, latencyMs, recordedAt: new Date().toISOString() }
    delete state.pending[id]
    return true
  })
  if (!result) throw Error('0G budget needs operator reconciliation before more requests.')
}
