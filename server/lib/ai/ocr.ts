import path from 'node:path'
import { createWorker, type Worker } from 'tesseract.js'
import { DATA_DIR } from '../../store.ts'

// tesseract.js runs locally (WASM). It fetches eng.traineddata once, then caches it in data/tesseract.
let workerPromise: Promise<Worker> | undefined

function getWorker() {
  workerPromise ??= createWorker('eng', 1, { cachePath: path.join(DATA_DIR, 'tesseract') })
  return workerPromise
}

export async function ocrImage(image: Buffer): Promise<string> {
  if (process.env.OCR_ENABLED === 'false') return ''
  try {
    const worker = await getWorker()
    const { data } = await worker.recognize(image)
    return data.text.replace(/\n{3,}/g, '\n\n').trim()
  } catch (err) {
    console.warn('[ocr] failed:', (err as Error).message)
    return ''
  }
}
