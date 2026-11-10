import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseEnv } from 'node:util'
import { localOllama } from './providers.mjs'
import { validateAnthropicBudget, reserveAnthropicRequest, recordAnthropicUsage } from './anthropic-budget.mjs'

export const directAnthropic = Object.freeze({
  kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', thinkingMode: 'between_tools'
})

export async function loadAgentModelProvider(root, settings = {}) {
  const kind = settings.provider ?? 'ollama'
  if (kind === 'ollama') return { ...localOllama, model: settings.model || 'qwen3:4b' }
  if (kind !== 'anthropic') throw Error('UNSUPPORTED_AGENT_MODEL_PROVIDER')
  const credentials = parseEnv(await readFile(settings.credentialsFile || join(root, '.local/inference/anthropic.env'), 'utf8'))
  if (credentials.ANTHROPIC_LIVE_ACCESS !== '1') throw Error('ANTHROPIC_PAID_CALLS_NOT_ENABLED')
  const provider = { ...directAnthropic, model: settings.model || directAnthropic.model,
    apiKey: credentials.ANTHROPIC_API_KEY, liveAccess: true,
    maxTokens: settings.maxTokens, timeoutMs: settings.timeoutMs, effort: settings.effort,
    thinkingMode: settings.thinkingMode || directAnthropic.thinkingMode,
    budget: { file: settings.budgetFile || join(root, '.local/inference/anthropic-usage.json'), authorizationId: settings.budgetId, limitUsd: settings.budgetUsd } }
  validateProvider(provider)
  await validateAnthropicBudget(provider.budget, provider.model)
  const response = await fetch(directAnthropic.baseUrl + '/models/' + encodeURIComponent(provider.model), {
    headers: { Authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2026-10-21' },
    redirect: 'error', signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw Error('ANTHROPIC_MODEL_HTTP_' + response.status)
  const capabilities = (await response.json()).capabilities, types = capabilities?.thinking?.types
  if(settings.thinkingMode){if(!types?.[settings.thinkingMode]?.supported)throw Error('ANTHROPIC_THINKING_MODE_UNAVAILABLE');provider.thinkingMode=settings.thinkingMode}
  else if (types?.disabled?.supported) provider.thinkingMode = 'disabled'
  else if (types?.between_tools?.supported) provider.thinkingMode = 'between_tools'
  else throw Error('ANTHROPIC_NONTHINKING_MODE_UNAVAILABLE')
  if(provider.effort&&!capabilities?.effort?.[provider.effort]?.supported)throw Error('ANTHROPIC_EFFORT_UNAVAILABLE')
  return provider
}

function validateProvider(provider) {
  if (provider.kind !== 'anthropic' || provider.baseUrl !== directAnthropic.baseUrl || provider.liveAccess !== true ||
      !['disabled', 'between_tools', 'adaptive'].includes(provider.thinkingMode) ||
      (provider.effort !== undefined && !['low','medium','high'].includes(provider.effort)) ||
      !/^claude-[a-z0-9.-]{1,70}$/.test(provider.model || '') ||
      typeof provider.apiKey !== 'string' || !/^sk-ant-[^\s]+$/.test(provider.apiKey) ||
      (provider.maxTokens !== undefined && (!Number.isInteger(provider.maxTokens) || provider.maxTokens < 1 || provider.maxTokens > 16384)) ||
      (provider.timeoutMs !== undefined && (!Number.isInteger(provider.timeoutMs) || provider.timeoutMs < 1 || provider.timeoutMs > 120000))) throw Error('INVALID_ANTHROPIC_CONFIGURATION')
}

export async function requestAnthropicPlan(provider, messages, schema, { maxTokens = provider.maxTokens ?? 4096, timeoutMs = provider.timeoutMs ?? 120000 } = {}) {
  validateProvider(provider)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > (provider.maxTokens ?? 4096) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (provider.timeoutMs ?? 120000) ||
      !Array.isArray(messages) || !messages.length || messages.some(value =>
        !['system', 'user', 'assistant'].includes(value.role) || typeof value.content !== 'string') ||
      !messages.some(value => value.role === 'user') || schema?.type !== 'object') throw Error('INVALID_ANTHROPIC_REQUEST')
  const request = { model: provider.model, max_tokens: maxTokens, stream: false,
      system: messages.filter(value => value.role === 'system').map(value => value.content).join('\n\n') +
        '\nReturn the proposed result by calling return_plan exactly once. This emits data for validation, never executes an action. Do not return the plan as plain text.',
      messages: messages.filter(value => value.role !== 'system'), thinking: { type: provider.thinkingMode },
      tools: [{ name: 'return_plan', description: 'Return the proposed plan for validation. This does not execute any action.', input_schema: schema }],
      ...(provider.effort?{output_config:{effort:provider.effort}}:{}),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true } }
  const reservationId = await reserveAnthropicRequest(provider, request)
  const response = await fetch(directAnthropic.baseUrl + '/messages', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}`, 'anthropic-version': '2026-10-21' },
    body: JSON.stringify(request)
  })
  if (!response.ok) throw Error('ANTHROPIC_HTTP_' + response.status)
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > 262144) throw Error('ANTHROPIC_RESPONSE_TOO_LARGE')
    chunks.push(chunk)
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  await recordAnthropicUsage(provider, reservationId, body, response.headers.get('request-id'))
  const tools = Array.isArray(body.content) ? body.content.filter(value => value.type === 'tool_use') : []
  let plan
  if (body.stop_reason === 'tool_use' && tools.length === 1 && tools[0].name === 'return_plan') plan = tools[0].input
  else if (body.stop_reason === 'end_turn' && Array.isArray(body.content) && body.content.length &&
      body.content.every(value => value.type === 'text' && typeof value.text === 'string')) {
    try { plan = JSON.parse(body.content.map(value => value.text).join('')) } catch { throw Error('INVALID_ANTHROPIC_PLAN') }
  }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw Error('INVALID_ANTHROPIC_PLAN')
  return plan
}
