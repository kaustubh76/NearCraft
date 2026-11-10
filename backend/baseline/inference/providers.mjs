export const localOllama = Object.freeze({
  kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/api', model: 'qwen3:1.7b'
})

const proposalSchema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['construct', 'inspect', 'repair_carry', 'wait'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 }
  },
  required: ['action', 'reason'], additionalProperties: false
}

export async function requestCompletion({ kind = 'router', baseUrl, apiKey, model, liveAccess = false }, messages) {
  const evidence = { mode: 'unconfigured', executed: false, live0GVerified: false, billingVerified: false }
  try {
    const url = new URL(baseUrl)
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    const ollama = kind === 'ollama'
    if (!['router', 'ollama'].includes(kind) || url.username || url.password || url.search || url.hash ||
        typeof model !== 'string' || !model.trim() || model.length > 200 ||
        (local && url.protocol !== 'http:') ||
        (ollama && (!local || url.pathname.replace(/\/$/, '') !== '/api')) ||
        (!ollama && ((!local && url.href.replace(/\/$/, '') !== 'https://router-api.0g.ai/v1') ||
          (!local && !liveAccess) || !apiKey))) throw new Error('invalid_provider_configuration')

    evidence.mode = ollama ? 'ollama_local' : local ? 'scripted_local_fixture' : 'remote_http'
    const response = await fetch(url.href.replace(/\/$/, '') + (ollama ? '/chat' : '/chat/completions'), {
      method: 'POST', redirect: 'error',
      headers: ollama ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(ollama
        ? { model, messages, stream: false, think: false, format: proposalSchema, options: { temperature: 0, num_predict: 256, num_ctx: 2048 } }
        : { model, messages, max_tokens: 256, temperature: 0 }),
      signal: AbortSignal.timeout(ollama ? 45000 : 5000)
    })
    if (!response.ok) throw new Error('provider_http_' + response.status)
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 65536) throw new Error('invalid_proposal')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (ollama && (body.done !== true || body.model !== model)) throw new Error('invalid_proposal')
    Object.assign(evidence, { model, responseId: body.id ?? body.created_at ?? null })
    if (ollama) Object.assign(evidence, { generatedTokens: body.eval_count, paidCalls: 0 })
    return { content: ollama ? body.message?.content : body.choices?.[0]?.message?.content, evidence }
  } catch (error) {
    evidence.failure = /^(invalid_proposal|invalid_provider_configuration|provider_http_[0-9]+)$/.test(error.message)
      ? error.message : 'invalid_or_unavailable_response'
    return { evidence }
  }
}
