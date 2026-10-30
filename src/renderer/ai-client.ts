// Renderer-side wrapper around the main-process AI service (ai.js).

export type AiFeature = 'autocomplete' | 'review' | 'chat' | 'tasks' | 'vision' | 'analysis' | 'proof'
export type AiProvider = 'ollama' | 'openai' | 'anthropic'

export type AiRequest = {
  feature: AiFeature
  system?: string
  messages?: { role: 'user' | 'assistant'; content: string }[]
  images?: { mediaType: string; base64: string }[]
  fim?: { prefix: string; suffix: string }
  maxTokens?: number
  stop?: string[]
  json?: boolean
}

export type AiResult = {
  text: string
  usage: { input?: number; output?: number }
  cost: number
  provider: AiProvider
  model: string
}

export type AiConfig = {
  enabled: boolean
  providers: { ollama: { url: string }; openai: { url: string }; anthropic: Record<string, never> }
  features: Partial<Record<AiFeature, { provider: AiProvider; model: string; enabled?: boolean }>>
  usage: Partial<Record<AiProvider, { requests: number; input: number; output: number; cost: number }>>
  hasKey: Partial<Record<AiProvider, boolean>>
}

type AiBridge = {
  config(): Promise<AiConfig>
  setConfig(patch: {
    enabled?: boolean
    features?: AiConfig['features']
    providers?: Partial<{ ollama: { url: string }; openai: { url: string } }>
  }): Promise<AiConfig>
  setKey(provider: AiProvider, key: string): Promise<AiConfig>
  run(id: string, req: AiRequest & { messages: NonNullable<AiRequest['messages']> }): Promise<AiResult>
  cancel(id: string): Promise<void>
  models(provider: AiProvider): Promise<{ id: string; size?: number; name?: string; capabilities?: string[] }[]>
  status(): Promise<{ running: boolean; version: string | null }>
  pull(model: string): Promise<void>
  onChunk(cb: (id: string, text: string) => void): void
  onPullProgress(cb: (model: string, p: { status: string; fraction: number | null }) => void): void
}

export const ai: AiBridge = (window as unknown as { texdesk: { ai: AiBridge } }).texdesk.ai

const listeners = new Map<string, (text: string) => void>()
ai.onChunk((id, text) => listeners.get(id)?.(text))

let counter = 0

/** Start a request; text streams to onText. Returns the final result plus a cancel handle. */
export function runAi(req: AiRequest, onText: (chunk: string, soFar: string) => void = () => {}) {
  const id = `ai-${Date.now()}-${counter++}`
  let soFar = ''
  listeners.set(id, chunk => {
    soFar += chunk
    onText(chunk, soFar)
  })
  const result = ai.run(id, { ...req, messages: req.messages ?? [] }).finally(() => listeners.delete(id))
  return { result, cancel: () => ai.cancel(id) }
}

let configCache: AiConfig | null = null
export async function aiConfig(refresh = false) {
  if (refresh || !configCache) configCache = await ai.config()
  return configCache
}
export function setConfigCache(c: AiConfig) {
  configCache = c
}

/** Is a feature usable right now (AI on, a model chosen, not switched off)? */
export async function featureReady(feature: AiFeature) {
  const c = await aiConfig()
  const f = c.features[feature]
  return c.enabled && !!f?.model && f.enabled !== false
}

/** Pull the first JSON value out of a model reply (tolerates code fences and chatter around it). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  if (start < 0) return null
  for (let end = body.length; end > start; end--) {
    const ch = body[end - 1]
    if (ch !== '}' && ch !== ']') continue
    try {
      return JSON.parse(body.slice(start, end)) as T
    } catch {}
  }
  return null
}
