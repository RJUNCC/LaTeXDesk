// AI service (main process). One streaming interface over three kinds of provider:
//   ollama    - local models (free, private); FIM for autocomplete via /api/generate's `suffix`
//   openai    - any OpenAI-compatible server (LM Studio, OpenRouter, OpenAI, ...)
//   anthropic - Claude via the official SDK
// Requests run here, not in the page, so API keys never reach the renderer.
const { safeStorage } = require('electron')
const Anthropic = require('@anthropic-ai/sdk').default

// $ per million tokens (input, output), for the usage counter. Local models are free.
const CLAUDE_PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-fable-5-1': [10, 50],
}
// effort per feature (Claude): autocomplete must be quick; tasks get more thought
const CLAUDE_EFFORT = { autocomplete: 'low', review: 'medium', chat: 'medium', vision: 'medium', tasks: 'high', analysis: 'medium', proof: 'high' }
// features that benefit from the model reasoning before it answers (local thinking models, Claude adaptive thinking)
const THINKING_FEATURES = new Set(['proof'])
// models where the server-side refusal fallback ("default" form) is available
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5'])

const running = new Map() // request id -> AbortController

/** Settings live in the app's settings.json; this module only reads/writes the `ai` part. */
function aiSettings(settings) {
  return {
    enabled: true,
    providers: { ollama: { url: 'http://localhost:11434' }, openai: { url: 'http://localhost:1234/v1' }, anthropic: {} },
    features: {},
    keys: {},
    usage: {},
    ...(settings.ai || {}),
  }
}

// ---------- API keys (encrypted with Windows DPAPI via safeStorage) ----------

function encryptKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure key storage is not available on this system')
  return safeStorage.encryptString(key).toString('base64')
}

function decryptKey(ai, provider) {
  const enc = ai.keys?.[provider]
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

// ---------- streaming helpers ----------

/** Yield parsed JSON objects from an NDJSON (Ollama) response body. */
async function* ndjson(res) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buf.trim()) yield JSON.parse(buf)
}

/** Yield `data:` payloads from an SSE (OpenAI-compatible) response body. */
async function* sse(res) {
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      yield JSON.parse(data)
    }
  }
}

async function checkOk(res, what) {
  if (res.ok) return
  let detail = ''
  try {
    detail = (await res.text()).slice(0, 300)
  } catch {}
  throw new Error(`${what} failed (HTTP ${res.status}) ${detail}`)
}

// ---------- providers ----------
// Each takes the normalized request and an `emit(text)` callback, and resolves to { usage }.

async function ollamaRun(ai, req, emit, signal) {
  const base = ai.providers.ollama.url.replace(/\/$/, '')
  const options = { num_predict: req.maxTokens ?? 1024, num_ctx: contextWindowFor(req), ...(req.stop?.length ? { stop: req.stop } : {}) }
  // models without native fill-in-the-middle get the same request phrased as a chat
  if (req.fim && !(await ollamaCapabilities(base, req.model)).includes('insert')) {
    return ollamaRun(ai, { ...req, fim: undefined, messages: [{ role: 'user', content: fimAsChat(req.fim) }] }, emit, signal)
  }
  if (req.fim) {
    // fill-in-the-middle: the model writes what goes between prefix and suffix
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      signal,
      body: JSON.stringify({ model: req.model, prompt: req.fim.prefix, suffix: req.fim.suffix, stream: true, options: { ...options, temperature: 0.2 } }),
    })
    await checkOk(res, 'Ollama generate')
    let usage = {}
    for await (const msg of ndjson(res)) {
      if (msg.error) throw new Error(msg.error)
      if (msg.response) emit(msg.response)
      if (msg.done) usage = { input: msg.prompt_eval_count ?? 0, output: msg.eval_count ?? 0 }
    }
    return { usage }
  }
  const messages = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  req.messages.forEach((m, i) => {
    const last = i === req.messages.length - 1
    messages.push({ role: m.role, content: m.content, ...(last && req.images?.length ? { images: req.images.map(im => im.base64) } : {}) })
  })
  // think: false keeps reasoning models (qwen3, ...) from spending the answer on hidden reasoning, except for
  // features where reasoning first pays off (proofs); only sent to models that support it
  const think = THINKING_FEATURES.has(req.feature) && (await ollamaCapabilities(base, req.model)).includes('thinking')
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    signal,
    body: JSON.stringify({ model: req.model, messages, stream: true, think, options, ...(req.json ? { format: 'json' } : {}) }),
  })
  await checkOk(res, 'Ollama chat')
  let usage = {}
  for await (const msg of ndjson(res)) {
    if (msg.error) throw new Error(msg.error)
    if (msg.message?.content) emit(msg.message.content)
    if (msg.done) usage = { input: msg.prompt_eval_count ?? 0, output: msg.eval_count ?? 0 }
  }
  return { usage }
}

async function openaiRun(ai, req, emit, signal) {
  const base = ai.providers.openai.url.replace(/\/$/, '')
  const key = decryptKey(ai, 'openai')
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }
  const messages = []
  if (req.system) messages.push({ role: 'system', content: req.system })
  // no FIM endpoint here: ask the chat model for just the missing middle
  const msgs = req.fim
    ? [{ role: 'user', content: fimAsChat(req.fim) }]
    : req.messages
  msgs.forEach((m, i) => {
    const last = i === msgs.length - 1
    if (last && req.images?.length) {
      messages.push({
        role: m.role,
        content: [
          ...req.images.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mediaType};base64,${im.base64}` } })),
          { type: 'text', text: m.content },
        ],
      })
    } else messages.push({ role: m.role, content: m.content })
  })
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens ?? 1024,
      ...(req.stop?.length ? { stop: req.stop } : {}),
    }),
  })
  await checkOk(res, 'Chat completion')
  let usage = {}
  for await (const ev of sse(res)) {
    const text = ev.choices?.[0]?.delta?.content
    if (text) emit(text)
    if (ev.usage) usage = { input: ev.usage.prompt_tokens ?? 0, output: ev.usage.completion_tokens ?? 0 }
  }
  return { usage }
}

/**
 * Ollama's default context is 4096 tokens and longer prompts are silently cut from the front, so size
 * the window to the request: about 3.5 characters per token, room for the answer, rounded up to a
 * power of two between 4k and 32k (32k fits a 14B model on a 16 GB GPU).
 */
function contextWindowFor(req) {
  const chars =
    (req.system?.length ?? 0) +
    (req.messages ?? []).reduce((n, m) => n + m.content.length, 0) +
    (req.fim ? req.fim.prefix.length + req.fim.suffix.length : 0)
  const needed = Math.ceil(chars / 3.5) + (req.maxTokens ?? 1024) + 512
  let ctx = 4096
  while (ctx < needed && ctx < 32768) ctx *= 2
  return ctx
}

const capabilityCache = new Map()

/** What an Ollama model can do: 'completion', 'insert' (FIM), 'vision', 'thinking', 'tools'. */
async function ollamaCapabilities(base, model) {
  if (!capabilityCache.has(model)) {
    const res = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model }) })
    await checkOk(res, `Ollama model ${model}`)
    capabilityCache.set(model, (await res.json()).capabilities ?? [])
  }
  return capabilityCache.get(model)
}

const fimAsChat = fim =>
  'Continue the LaTeX document at <CURSOR>. Reply with ONLY the text to insert at the cursor ' +
  '(no explanations, no code fences, do not repeat existing text). Keep it short: at most one sentence or a few lines.\n\n' +
  `${fim.prefix}<CURSOR>${fim.suffix}`

async function anthropicRun(ai, req, emit, signal) {
  const apiKey = decryptKey(ai, 'anthropic')
  if (!apiKey) throw new Error('No Claude API key set (AI settings)')
  const client = new Anthropic({ apiKey })
  const userContent = text =>
    req.images?.length
      ? [
          ...req.images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.mediaType, data: im.base64 } })),
          { type: 'text', text },
        ]
      : text
  const msgs = req.fim ? [{ role: 'user', content: fimAsChat(req.fim) }] : req.messages
  const messages = msgs.map((m, i) => ({ role: m.role, content: i === msgs.length - 1 && m.role === 'user' ? userContent(m.content) : m.content }))
  const params = {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    messages,
    ...(req.system ? { system: req.system } : {}),
    ...(req.stop?.length ? { stop_sequences: req.stop } : {}),
    output_config: { effort: CLAUDE_EFFORT[req.feature] ?? 'medium' },
    ...(THINKING_FEATURES.has(req.feature) ? { thinking: { type: 'adaptive' } } : {}),
  }
  // on a safety decline, let the API re-run the request on a suitable fallback model
  if (FALLBACK_MODELS.has(req.model)) {
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  const stream = client.beta.messages.stream(params, { signal })
  stream.on('text', emit)
  const final = await stream.finalMessage()
  if (final.stop_reason === 'refusal') throw new Error('Claude declined this request')
  return { usage: { input: final.usage.input_tokens ?? 0, output: final.usage.output_tokens ?? 0 }, model: final.model }
}

const PROVIDERS = { ollama: ollamaRun, openai: openaiRun, anthropic: anthropicRun }

/**
 * Run one request. `req`: { feature, system?, messages: [{role, content}], images?: [{mediaType, base64}],
 * fim?: {prefix, suffix}, maxTokens?, stop?, json? } — provider/model come from the feature's settings
 * unless given. Streams text through `onText`; resolves to { text, usage, cost, provider, model }.
 */
async function run(settings, id, req, onText) {
  const ai = aiSettings(settings)
  if (!ai.enabled) throw new Error('AI is turned off (AI settings)')
  const choice = ai.features[req.feature] || {}
  const provider = req.provider || choice.provider
  const model = req.model || choice.model
  if (!provider || !model) throw new Error(`No model chosen for ${req.feature} (AI settings)`)
  const runProvider = PROVIDERS[provider]
  if (!runProvider) throw new Error(`Unknown AI provider: ${provider}`)

  const controller = new AbortController()
  running.set(id, controller)
  let text = ''
  try {
    const result = await runProvider(ai, { ...req, model }, t => ((text += t), onText(t)), controller.signal)
    const price = provider === 'anthropic' ? CLAUDE_PRICES[result.model ?? model] : null
    const usage = result.usage || {}
    const cost = price ? ((usage.input || 0) * price[0] + (usage.output || 0) * price[1]) / 1e6 : 0
    return { text, usage, cost, provider, model }
  } finally {
    running.delete(id)
  }
}

function cancel(id) {
  running.get(id)?.abort()
  running.delete(id)
}

/** Model ids a provider offers, for the settings picker. */
async function listModels(settings, provider) {
  const ai = aiSettings(settings)
  if (provider === 'ollama') {
    const res = await fetch(`${ai.providers.ollama.url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(4000) })
    await checkOk(res, 'Ollama')
    const data = await res.json()
    const base = ai.providers.ollama.url.replace(/\/$/, '')
    return Promise.all(
      data.models.map(async m => ({ id: m.name, size: m.size, capabilities: await ollamaCapabilities(base, m.name).catch(() => []) }))
    )
  }
  if (provider === 'openai') {
    const key = decryptKey(ai, 'openai')
    const res = await fetch(`${ai.providers.openai.url.replace(/\/$/, '')}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(6000),
    })
    await checkOk(res, 'Model list')
    return (await res.json()).data.map(m => ({ id: m.id }))
  }
  if (provider === 'anthropic') {
    const apiKey = decryptKey(ai, 'anthropic')
    if (!apiKey) throw new Error('Add a Claude API key first')
    const client = new Anthropic({ apiKey })
    const out = []
    for await (const m of client.models.list()) out.push({ id: m.id, name: m.display_name })
    return out
  }
  return []
}

/** Is Ollama running, and which version? */
async function ollamaStatus(settings) {
  const ai = aiSettings(settings)
  try {
    const res = await fetch(`${ai.providers.ollama.url.replace(/\/$/, '')}/api/version`, { signal: AbortSignal.timeout(2000) })
    return { running: res.ok, version: res.ok ? (await res.json()).version : null }
  } catch {
    return { running: false, version: null }
  }
}

/** Download a model into Ollama, reporting progress (0..1) as it goes. */
async function ollamaPull(settings, model, onProgress) {
  const ai = aiSettings(settings)
  const res = await fetch(`${ai.providers.ollama.url.replace(/\/$/, '')}/api/pull`, {
    method: 'POST',
    body: JSON.stringify({ model, stream: true }),
  })
  await checkOk(res, `Downloading ${model}`)
  for await (const msg of ndjson(res)) {
    if (msg.error) throw new Error(msg.error)
    onProgress({ status: msg.status, fraction: msg.total ? (msg.completed ?? 0) / msg.total : null })
  }
}

module.exports = { run, cancel, listModels, ollamaStatus, ollamaPull, encryptKey, aiSettings, CLAUDE_PRICES }
