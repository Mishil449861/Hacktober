// Bring your own key: a visitor's key is used only for their own analysis, sent only to a fixed provider
// address, and the page can't make the server call an address of its choosing. No network: fetch is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.LOCAL_AI_PROVIDER = 'ollama'
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9'
const { AI_PROVIDERS, checkKey, createRuntime, imageMime, keyRuntime, providerMessage, withAi } = await import('../server/lib/ai/runtimes.ts')

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> }
/** Replace fetch: record every call, answer with `reply(call)` (status, json). */
function fakeFetch(reply: (c: Call) => [number, unknown]) {
  const calls: Call[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : {} }
    calls.push(c)
    const [status, json] = reply(c)
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}
const ok = (content: string): [number, unknown] => [200, { choices: [{ message: { content } }] }]
const req = { system: 's', user: 'u', jsonSchema: { type: 'object' } }

test('a visitor key goes to the fixed provider address with a Bearer header, only inside withAi', async () => {
  const f = fakeFetch(() => ok('{"ok":true}'))
  try {
    const runtime = createRuntime()
    const reply = await withAi({ provider: 'gemini', apiKey: 'k-123' }, () => runtime.chat(req))
    assert.equal(reply, '{"ok":true}')
    assert.equal(f.calls[0].url, `${AI_PROVIDERS.gemini.baseUrl}/chat/completions`)
    assert.equal(f.calls[0].headers.Authorization, 'Bearer k-123')
    assert.equal(f.calls[0].body.model, 'gemini-3.8-flash', 'the provider default model')
    assert.equal(runtime.name, 'ollama', 'outside withAi the local runtime is back')
  } finally { f.restore() }
})

test('two visitors at once each use their own key', async () => {
  const f = fakeFetch((c) => ok(c.headers.Authorization))
  try {
    const runtime = createRuntime()
    const [a, b] = await Promise.all([
      withAi({ provider: 'gemini', apiKey: 'alice' }, async () => { await new Promise((r) => setTimeout(r, 20)); return runtime.chat(req) }),
      withAi({ provider: 'openai', apiKey: 'bob', model: 'some-model' }, () => runtime.chat(req)),
    ])
    assert.equal(a, 'Bearer alice')
    assert.equal(b, 'Bearer bob')
    assert.ok(f.calls.some((c) => c.url.startsWith('https://api.openai.com/') && c.body.model === 'some-model'))
  } finally { f.restore() }
})

test('a provider that refuses the JSON schema is asked again in plain JSON mode', async () => {
  const f = fakeFetch((c) => ((c.body.response_format as { type: string }).type === 'json_schema' ? [400, { error: 'schema not supported' }] : ok('{"a":1}')))
  try {
    assert.equal(await keyRuntime({ provider: 'groq', apiKey: 'k', model: 'm' }).chat(req), '{"a":1}')
    assert.deepEqual(f.calls.map((c) => (c.body.response_format as { type: string }).type), ['json_schema', 'json_object'])
  } finally { f.restore() }
})

test("Gemini is asked for low reasoning effort, and a model that refuses it is asked again without", async () => {
  const f = fakeFetch((c) => ('reasoning_effort' in c.body ? [400, { error: 'unsupported' }] : ok('{"ok":true}')))
  try {
    assert.equal(await keyRuntime({ provider: 'gemini', apiKey: 'k' }).chat(req), '{"ok":true}')
    assert.deepEqual(f.calls.map((c) => [c.body.reasoning_effort ?? '-', (c.body.response_format as { type: string }).type]),
      [['low', 'json_schema'], ['-', 'json_schema']])
  } finally { f.restore() }
})

test('the key check lists models (fast, no generation) and explains a wrong model name', async () => {
  const models = { data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.5-flash-lite' }] }
  let f = fakeFetch(() => [200, models])
  try {
    assert.equal(await checkKey({ provider: 'gemini', apiKey: 'k' }), 'gemini-3.8-flash')
    assert.equal(f.calls.length, 1, 'one quick request')
    assert.match(f.calls[0].url, /\/models$/)
    await assert.rejects(checkKey({ provider: 'gemini', apiKey: 'k', model: 'gemini-9-flash' }),
      /can't use the model "gemini-9-flash"\. Models it can use include: gemini-3\.8-flash, gemini-3\.5-flash-lite/)
  } finally { f.restore() }
  f = fakeFetch(() => [400, [{ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }]])
  try {
    await assert.rejects(checkKey({ provider: 'gemini', apiKey: 'bad' }), /^Error: Google Gemini rejected the key: API key not valid/)
  } finally { f.restore() }
})

test('providerMessage keeps the human part of an error body', () => {
  assert.equal(providerMessage('{"error":{"message":"Quota exceeded"}}'), 'Quota exceeded')
  assert.equal(providerMessage('[{"error":{"message":"Bad key"}}]'), 'Bad key')
  assert.equal(providerMessage('Service  Unavailable'), 'Service Unavailable')
})

test('other errors are not retried, and say what the provider said', async () => {
  const f = fakeFetch(() => [401, { error: 'API key not valid' }])
  try {
    await assert.rejects(keyRuntime({ provider: 'gemini', apiKey: 'bad' }).chat(req), /401 .*API key not valid/)
    assert.equal(f.calls.length, 1)
  } finally { f.restore() }
})

test('only listed providers; a model and a key are required', () => {
  assert.throws(() => keyRuntime({ provider: 'http://169.254.169.254', apiKey: 'k' }), /Unknown AI provider/)
  assert.throws(() => keyRuntime({ provider: 'openai', apiKey: 'k' }), /Choose a model for OpenAI/)
  assert.throws(() => keyRuntime({ provider: 'gemini', apiKey: '  ' }), /Add your Google Gemini API key/)
  assert.equal(AI_PROVIDERS['test-ollama'], undefined, 'the local test provider only exists with ORGMAP_TEST_PROVIDER=true')
  for (const p of Object.values(AI_PROVIDERS)) assert.match(p.baseUrl, /^https:\/\//, `${p.label} is reached over HTTPS`)
})

test('images are sent with their real type', () => {
  assert.equal(imageMime('iVBORw0KGgo'), 'image/png')
  assert.equal(imageMime('/9j/4AAQ'), 'image/jpeg')
  assert.equal(imageMime('UklGRiQAAABXRUJQ'), 'image/webp')
})
