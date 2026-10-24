/**
 * Model runtime clients. By default only localhost endpoints: Ollama's native API, or any
 * OpenAI-compatible local server (LM Studio, llama.cpp server, LocalAI).
 *
 * Bring your own key: when a visitor of a hosted demo supplies an AI key, the analysis of their notes
 * runs inside withAi(), and every model call in it goes to that provider instead (see createRuntime).
 * Providers are a fixed list, so a visitor can't point the server at an address of their choosing.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface ChatRequest {
  system: string
  user: string
  images?: string[] // base64, no data: prefix
  jsonSchema: object
  vision?: boolean
}

export interface LocalRuntime {
  name: string
  reachable(): Promise<boolean>
  textModel(): Promise<string | undefined>
  visionModel(): Promise<string | undefined>
  chat(req: ChatRequest): Promise<string>
}

const TIMEOUT_MS = Number(process.env.LOCAL_AI_TIMEOUT_MS ?? 600_000)

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new HttpError(`${url} -> ${res.status} ${(await res.text()).slice(0, 600)}`, res.status)
  return res.json()
}

/** The image type from its first bytes, for the data: URL (providers check it matches). */
export function imageMime(base64: string) {
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('UklGR')) return 'image/webp'
  if (base64.startsWith('R0lGOD')) return 'image/gif'
  return 'image/jpeg'
}

/**
 * Ollama chat, streamed. Not streaming means no response headers until the whole answer is generated, and
 * Node's fetch gives up waiting for headers after 300 s ("fetch failed", HeadersTimeoutError) whatever
 * TIMEOUT_MS says: a slow photo on a small GPU then silently fell back to tesseract OCR of handwriting.
 */
async function streamChat(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok || !res.body) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = '', content = '', doneReason: string | undefined
  const take = (line: string) => {
    if (!line.trim()) return
    const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean; done_reason?: string; error?: string }
    if (chunk.error) throw new Error(`${url} -> ${chunk.error}`)
    content += chunk.message?.content ?? ''
    if (chunk.done) doneReason = chunk.done_reason
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
  }
  take(buf)
  return { message: { content }, done_reason: doneReason }
}

// ---------------- Ollama ----------------

/**
 * Smallest context bucket that fits prompt + output. A smaller KV cache leaves more VRAM for model
 * layers (qwen3:14b on an 8GB GPU: 4096 ctx runs noticeably faster than 8192). Buckets, not exact
 * sizes, because Ollama reloads the model whenever num_ctx changes.
 */
function contextFor(req: ChatRequest, minimum: number) {
  const max = Number(process.env.OLLAMA_NUM_CTX ?? 16384)
  const promptTokens = Math.ceil((req.system.length + req.user.length) / 3.2) + (req.images?.length ?? 0) * 3300
  const need = promptTokens + 3072
  return Math.min(max, [4096, 8192, 16384, 32768].find((b) => b >= Math.max(need, minimum)) ?? max)
}

// Preference order when the env var does not pin a model. Picked from what `ollama list` reports.
const VISION_PREFS = ['qwen2.5vl:7b', 'qwen3-vl', 'qwen2.5vl', 'minicpm-v', 'gemma3', 'llama3.2-vision', 'llava', 'mistral-small3']
const TEXT_PREFS = ['qwen3:14b', 'qwen3:30b', 'qwen3', 'qwen2.5:14b', 'qwen2.5', 'llama3.1', 'mistral', 'qwen2.5-coder:7b']

export function ollamaRuntime(): LocalRuntime {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '')
  const caps = new Map<string, string[]>()
  let tagsCache: { at: number; names: string[] } | undefined

  async function tags(): Promise<string[]> {
    if (tagsCache && Date.now() - tagsCache.at < 15_000) return tagsCache.names
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) })
    const json = (await res.json()) as { models: { name: string }[] }
    tagsCache = { at: Date.now(), names: json.models.map((m) => m.name) }
    return tagsCache.names
  }

  async function capabilities(model: string): Promise<string[]> {
    if (!caps.has(model)) {
      const json = (await post(`${base}/api/show`, { model })) as { capabilities?: string[] }
      caps.set(model, json.capabilities ?? [])
    }
    return caps.get(model)!
  }

  async function pick(prefs: string[], needVision: boolean) {
    const names = (await tags()).filter((n) => !n.includes('embed'))
    const ordered = [
      ...prefs.flatMap((p) => names.filter((n) => n === p || n.startsWith(p.includes(':') ? p : p + ':'))),
      ...names,
    ]
    for (const name of ordered) {
      const c = await capabilities(name).catch((): string[] => [])
      if (needVision ? c.includes('vision') : c.includes('completion')) return name
    }
  }

  // On a 16GB machine the text (~10GB) and vision (~6GB) models cannot both stay resident:
  // unload the previous model before switching so only one is ever loaded.
  const unloadOnSwitch = process.env.OLLAMA_UNLOAD_ON_SWITCH !== 'false'
  // "5m", "24h", or a plain number of seconds; Ollama rejects a bare "-1" string ("missing unit in duration")
  // but accepts the number -1, which keeps the model loaded indefinitely.
  const keepAliveRaw = process.env.OLLAMA_KEEP_ALIVE ?? '5m'
  const keepAlive = /^-?\d+$/.test(keepAliveRaw.trim()) ? Number(keepAliveRaw) : keepAliveRaw
  async function switchTo(model: string) {
    if (!unloadOnSwitch) return
    // Ask Ollama what is resident (any client may have loaded it), and evict everything else.
    const ps = await fetch(`${base}/api/ps`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.json() as Promise<{ models?: { name: string }[] }>)
      .catch(() => ({ models: [] as { name: string }[] }))
    for (const m of ps.models ?? []) {
      if (m.name !== model) await post(`${base}/api/generate`, { model: m.name, keep_alive: 0 }).catch(() => undefined)
    }
  }

  return {
    name: 'ollama',
    reachable: () => tags().then(() => true, () => false),
    // Single-model mode (default): if a vision model is available, it handles text too. On an 8GB GPU
    // that is 3-5x faster than qwen3:14b (fully on GPU) and avoids a model swap between every photo
    // and every page of minutes. Set OLLAMA_SINGLE_MODEL=false (or OLLAMA_MODEL) to use a separate text model.
    textModel: async () =>
      process.env.OLLAMA_MODEL ||
      (process.env.OLLAMA_SINGLE_MODEL !== 'false' ? await pick(VISION_PREFS, true) : undefined) ||
      pick(TEXT_PREFS, false),
    visionModel: async () => process.env.OLLAMA_VISION_MODEL || pick(VISION_PREFS, true),
    async chat(req) {
      const model = req.vision ? await this.visionModel() : await this.textModel()
      if (!model) throw new Error(req.vision ? 'No local vision model available' : 'No local text model available')
      const c = await capabilities(model).catch(() => [] as string[])
      await switchTo(model)
      const json = await streamChat(`${base}/api/chat`, {
        model,
        keep_alive: keepAlive,
        format: req.jsonSchema,
        // qwen3-style reasoning models: skip the <think> phase, we want direct JSON.
        ...(c.includes('thinking') ? { think: false } : {}),
        // A vision model also serves images (which need ~8K), so keep it at >= 8192: changing num_ctx
        // between calls makes Ollama reload the model (that alone cost ~60s per switch).
        options: { temperature: 0.1, num_ctx: contextFor(req, c.includes('vision') ? 8192 : 4096), num_predict: 3072 },
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user, ...(req.images?.length ? { images: req.images } : {}) },
        ],
      })
      if (json.done_reason && json.done_reason !== 'stop') {
        console.warn(`[ollama] ${model} stopped early (done_reason=${json.done_reason}, ${json.message.content.length} chars)`)
      }
      return json.message.content
    },
  }
}

// ---------------- OpenAI-compatible server (LM Studio etc., or a hosted provider with a visitor's key) ----------------

export interface OpenAiCompatConfig { name: string; baseUrl: string; apiKey?: string; model?: string; visionModel?: string }

export function openAiCompatRuntime(cfg?: OpenAiCompatConfig): LocalRuntime {
  const base = (cfg?.baseUrl ?? process.env.LOCAL_AI_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/$/, '')
  const model = cfg ? cfg.model : process.env.LOCAL_AI_MODEL
  const visionModel = (cfg ? cfg.visionModel : process.env.LOCAL_AI_VISION_MODEL) || model
  const auth: Record<string, string> = cfg?.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}
  return {
    name: cfg?.name ?? process.env.LOCAL_AI_PROVIDER ?? 'lmstudio',
    reachable: () => fetch(`${base}/models`, { headers: auth, signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false),
    textModel: async () => model,
    visionModel: async () => visionModel,
    async chat(req) {
      const content: unknown[] = [{ type: 'text', text: req.user }]
      for (const img of req.images ?? []) content.push({ type: 'image_url', image_url: { url: `data:${imageMime(img)};base64,${img}` } })
      const body = {
        model: req.vision ? visionModel : model,
        temperature: 0.1,
        messages: [{ role: 'system', content: req.system }, { role: 'user', content }],
      }
      let json: { choices: { message: { content: string | null } }[] }
      try {
        json = await post(`${base}/chat/completions`, {
          ...body, response_format: { type: 'json_schema', json_schema: { name: 'output', schema: req.jsonSchema } },
        }, auth)
      } catch (e) {
        // Some providers/models refuse a full JSON schema but take plain JSON mode; the reply is validated anyway.
        if (!(e instanceof HttpError) || e.status !== 400) throw e
        json = await post(`${base}/chat/completions`, { ...body, response_format: { type: 'json_object' } }, auth)
      }
      return json.choices?.[0]?.message?.content ?? ''
    },
  }
}

// ---------------- bring your own key ----------------

/** Hosted providers a visitor can use with their own key. Fixed addresses: never taken from the request. */
export const AI_PROVIDERS: Record<string, { label: string; baseUrl: string; defaultModel?: string; keyUrl: string }> = {
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.8-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
}
// For tests only: the local Ollama through its OpenAI-compatible endpoint, as if it were a hosted provider.
if (process.env.ORGMAP_TEST_PROVIDER === 'true') {
  AI_PROVIDERS['test-ollama'] = { label: 'Test: local Ollama (OpenAI API)', baseUrl: process.env.ORGMAP_TEST_PROVIDER_URL ?? 'http://localhost:11434/v1', defaultModel: 'qwen2.5vl:7b', keyUrl: '' }
}

export interface AiKey { provider: string; apiKey: string; model?: string }

/** A visitor's key as a runtime, or why it can't be used. */
export function keyRuntime(k: AiKey): LocalRuntime {
  const p = AI_PROVIDERS[k.provider]
  if (!p) throw new Error(`Unknown AI provider "${k.provider}"`)
  const model = k.model?.trim() || p.defaultModel
  if (!model) throw new Error(`Choose a model for ${p.label}`)
  if (!k.apiKey?.trim()) throw new Error(`Add your ${p.label} API key`)
  return openAiCompatRuntime({ name: k.provider, baseUrl: p.baseUrl, apiKey: k.apiKey.trim(), model })
}

const visitorKey = new AsyncLocalStorage<LocalRuntime>()
/** Run fn with every model call in it going to the visitor's provider and key. */
export const withAi = <T>(k: AiKey, fn: () => Promise<T>) => visitorKey.run(keyRuntime(k), fn)

/** The configured local runtime, or the visitor's provider while inside withAi(). */
export function createRuntime(): LocalRuntime {
  const p = (process.env.LOCAL_AI_PROVIDER ?? 'ollama').toLowerCase()
  const local = p === 'ollama' ? ollamaRuntime() : openAiCompatRuntime()
  const current = () => visitorKey.getStore() ?? local
  return {
    get name() { return current().name },
    reachable: () => current().reachable(),
    textModel: () => current().textModel(),
    visionModel: () => current().visionModel(),
    chat: (req) => current().chat(req),
  }
}
