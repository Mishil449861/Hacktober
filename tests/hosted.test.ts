// The online demo's safety nets: Gemini settings, reading fenced JSON, and never overwriting the boards
// backup after a failed restore. No network: fetch is faked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'orgmap-hosted-test-'))
process.env.ORGMAP_DB_BACKUP = 'cloudinary'
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud'
process.env.CLOUDINARY_API_KEY = '123'
process.env.CLOUDINARY_API_SECRET = 'not-a-secret'
process.env.ORGMAP_BACKUP_RETRY_MS = '1'
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:9'
const { keyRuntime } = await import('../server/lib/ai/runtimes.ts')
const { tryParse } = await import('../server/lib/ai/provider.ts')
const { backupState, restoreBackup, startBackup } = await import('../server/backup.ts')
const { store } = await import('../server/store.ts')
const { ExtractionSchema } = await import('../src/shared/schema.ts')

function fakeFetch(reply: (url: string, body: Record<string, unknown>) => Response) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    calls.push({ url: String(url), body })
    return reply(String(url), body)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = real } }
}

test('Gemini gets its default temperature (Google: below 1.0 may loop) and low reasoning effort', async () => {
  const f = fakeFetch(() => Response.json({ choices: [{ message: { content: '{}' } }] }))
  try {
    await keyRuntime({ provider: 'gemini', apiKey: 'k' }).chat({ system: 's', user: 'u', jsonSchema: {} })
    assert.equal('temperature' in f.calls[0].body, false)
    assert.equal(f.calls[0].body.reasoning_effort, 'low')
    await keyRuntime({ provider: 'openai', apiKey: 'k', model: 'm' }).chat({ system: 's', user: 'u', jsonSchema: {} })
    assert.equal(f.calls[1].body.temperature, 0.1, 'other providers keep the low temperature')
  } finally { f.restore() }
})

test('model replies wrapped in code fences or prose still parse', () => {
  const json = '{"summary":"s","nodes":[],"edges":[],"ambiguities":[]}'
  for (const raw of [json, '```json\n' + json + '\n```', 'Here you go:\n' + json + '\nHope this helps.', '<think>{x}</think>' + json]) {
    assert.equal(tryParse(ExtractionSchema, raw).ok, true, raw)
  }
})

test('a failed restore never lets the empty new start overwrite the boards backup', async () => {
  assert.equal(store.db.workspaces.length, 0)
  const f = fakeFetch(() => new Response('Service Unavailable', { status: 503 }))
  try {
    await restoreBackup()
  } finally { f.restore() }
  assert.equal(f.calls.length, 3, 'tried three times')
  startBackup()
  assert.deepEqual(backupState(), { enabled: true, restoreFailed: true, active: false })
})
