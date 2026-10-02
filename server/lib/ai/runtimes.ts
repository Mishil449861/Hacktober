/**
 * Local runtime clients. Only localhost endpoints: Ollama native API, or any
 * OpenAI-compatible local server (LM Studio, llama.cpp server, LocalAI).
 */

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

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${url} -> ${res.status} ${await res.text()}`)
  return res.json()
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
  const keepAlive = process.env.OLLAMA_KEEP_ALIVE ?? '5m'
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
      const json = (await post(`${base}/api/chat`, {
        model,
        stream: false,
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
      })) as { message: { content: string }; done_reason?: string }
      if (json.done_reason && json.done_reason !== 'stop') {
        console.warn(`[ollama] ${model} stopped early (done_reason=${json.done_reason}, ${json.message.content.length} chars)`)
      }
      return json.message.content
    },
  }
}

// ---------------- OpenAI-compatible local server (LM Studio etc.) ----------------

export function openAiCompatRuntime(): LocalRuntime {
  const base = (process.env.LOCAL_AI_BASE_URL ?? 'http://localhost:1234/v1').replace(/\/$/, '')
  const model = process.env.LOCAL_AI_MODEL
  const visionModel = process.env.LOCAL_AI_VISION_MODEL || model
  return {
    name: process.env.LOCAL_AI_PROVIDER ?? 'lmstudio',
    reachable: () => fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
    textModel: async () => model,
    visionModel: async () => visionModel,
    async chat(req) {
      const content: unknown[] = [{ type: 'text', text: req.user }]
      for (const img of req.images ?? []) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img}` } })
      const json = (await post(`${base}/chat/completions`, {
        model: req.vision ? visionModel : model,
        temperature: 0.1,
        response_format: { type: 'json_schema', json_schema: { name: 'output', schema: req.jsonSchema } },
        messages: [{ role: 'system', content: req.system }, { role: 'user', content }],
      })) as { choices: { message: { content: string } }[] }
      return json.choices[0].message.content
    },
  }
}

export function createRuntime(): LocalRuntime {
  const p = (process.env.LOCAL_AI_PROVIDER ?? 'ollama').toLowerCase()
  return p === 'ollama' ? ollamaRuntime() : openAiCompatRuntime()
}
