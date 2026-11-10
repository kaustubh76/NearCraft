import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { zeroGModel, zeroGModels, validateZeroGBudget, reserveZeroGRequest, recordZeroGUsage } from './zero-g-budget.mjs'

export const zeroGRouter = Object.freeze({ kind: '0g', baseUrl: 'https://router-api.0g.ai/v1', model: zeroGModel.model })

function validateProvider(provider) {
  if (provider.kind !== '0g' || provider.baseUrl !== zeroGRouter.baseUrl || !zeroGModels[provider.model] ||
      provider.liveAccess !== true || typeof provider.apiKey !== 'string' || !/^sk-[^\s]+$/.test(provider.apiKey) ||
      (provider.maxTokens !== undefined && (!Number.isInteger(provider.maxTokens) || provider.maxTokens < 1 || provider.maxTokens > 4096)) ||
      (provider.timeoutMs !== undefined && (!Number.isInteger(provider.timeoutMs) || provider.timeoutMs < 1 || provider.timeoutMs > 120000))) {
    throw Error('INVALID_ZERO_G_CONFIGURATION')
  }
}

async function readBoundedJson(response) {
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 1048576) throw Error('ZERO_G_RESPONSE_TOO_LARGE')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function verifyPricing(modelId) {
  const response = await fetch(zeroGRouter.baseUrl + '/models', { redirect: 'error', signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw Error('ZERO_G_CATALOG_HTTP_' + response.status)
  const expected=zeroGModels[modelId],standard=modelId===zeroGModel.model
  const rates=standard?[0.0000009,0.0000033]:[0.000000058333,0.000000466667]
  const model = (await readBoundedJson(response)).data?.find(value => value.id === modelId)
  if (!model || Number(model.pricing_usd?.prompt) !== rates[0] || Number(model.pricing_usd?.completion) !== rates[1] ||
      model.context_length !== expected.contextTokens || (standard?!(model.max_completion_tokens>=4096):model.max_completion_tokens!==undefined&&model.max_completion_tokens<4096) ||
      !(standard?['tools','tool_choice']:['tools']).every(value=>model.supported_parameters?.includes(value))) throw Error('ZERO_G_PRICE_OR_CAPABILITIES_CHANGED')
  return {...expected,source:zeroGRouter.baseUrl+'/models',observedAt:new Date().toISOString(),publishedInputUsd:model.pricing_usd.prompt,publishedOutputUsd:model.pricing_usd.completion}
}

export async function loadZeroGProvider(root, settings = {}) {
  const credentials = parseEnv(await readFile(settings.credentialsFile || join(root, '.local/inference/zero-g.env'), 'utf8'))
  if (credentials.ZERO_G_LIVE_ACCESS !== '1') throw Error('ZERO_G_PAID_CALLS_NOT_ENABLED')
  const provider = { ...zeroGRouter, model: settings.model || zeroGRouter.model, apiKey: credentials.ZERO_G_API_KEY, liveAccess: true,
    maxTokens: settings.maxTokens, timeoutMs: settings.timeoutMs,
    budget: { file: settings.budgetFile || join(root, '.local/inference/zero-g-usage.json'), authorizationId: settings.budgetId, limitUsd: settings.budgetUsd } }
  validateProvider(provider)
  await validateZeroGBudget(provider.budget)
  await verifyPricing(provider.model)
  return provider
}

export async function requestZeroGPlan(provider, messages, schema, { maxTokens = provider.maxTokens ?? 4096, timeoutMs = provider.timeoutMs ?? 120000 } = {}) {
  validateProvider(provider)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > (provider.maxTokens ?? 4096) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (provider.timeoutMs ?? 120000) ||
      !Array.isArray(messages) || !messages.length || messages.some(value =>
        !['system', 'user', 'assistant'].includes(value.role) || typeof value.content !== 'string') ||
      !messages.some(value => value.role === 'user') || schema?.type !== 'object') throw Error('INVALID_ZERO_G_REQUEST')
  const request = { model: provider.model, max_tokens: maxTokens, stream: false,
    messages: [{ role: 'system', content: 'Return the proposed result by calling return_plan exactly once. This emits data for validation and never executes an action.' }, ...messages],
    tools: [{ type: 'function', function: { name: 'return_plan', description: 'Return a proposed plan for validation; never execute actions.', parameters: schema } }],
    ...(provider.model===zeroGModel.model?{tool_choice:{type:'function',function:{name:'return_plan'}}}:{}) }
  // Bound prompt/schema size independently of the provider's much larger context ceiling.
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 32000) throw Error('ZERO_G_INPUT_TOO_LARGE')
  const pricing = await verifyPricing(provider.model)
  const reservationId = await reserveZeroGRequest(provider, request, pricing)
  const start = Date.now()
  // Failed/lost responses retain their reservation: the provider may already have charged them.
  const response = await fetch(zeroGRouter.baseUrl + '/chat/completions', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` }, body: JSON.stringify(request)
  })
  if (!response.ok) throw Error('ZERO_G_HTTP_' + response.status)
  const body = await readBoundedJson(response)
  await recordZeroGUsage(provider, reservationId, body, response.headers.get('x-request-id'), Date.now() - start)
  const choices = body.choices, tools = choices?.[0]?.message?.tool_calls
  if (!Array.isArray(choices) || choices.length !== 1 || choices[0].finish_reason !== 'tool_calls' ||
      !Array.isArray(tools) || tools.length !== 1 || tools[0].type !== 'function' || tools[0].function?.name !== 'return_plan' ||
      typeof tools[0].function.arguments !== 'string') throw Error('INVALID_ZERO_G_PLAN')
  let plan
  try { plan = JSON.parse(tools[0].function.arguments) } catch { throw Error('INVALID_ZERO_G_PLAN') }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw Error('INVALID_ZERO_G_PLAN')
  return plan
}
