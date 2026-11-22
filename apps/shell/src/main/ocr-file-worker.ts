import { parentPort, workerData } from 'node:worker_threads'
import { convertOcrFile } from './ocr-file'
import { ensurePdfium } from './pdf2docx-local'
import {
  createVisionOcrEngine,
  createWindowsOcrEngine,
} from '../../../../packages/pdf2docx/src/ocr-vision'

async function run() {
  const { input, target, output, resourcesPath, helper, options } = workerData
  if (!process.resourcesPath && resourcesPath)
    Object.defineProperty(process, 'resourcesPath', { value: resourcesPath })
  const create = process.platform === 'darwin' ? createVisionOcrEngine : createWindowsOcrEngine
  const missing = await convertOcrFile(
    input,
    target,
    output,
    await ensurePdfium(),
    create(helper, options?.language ? [options.language] : undefined, Boolean(options?.language)),
    options?.pageRange,
  )
  parentPort!.postMessage({ missing })
}
if (parentPort)
  void run().catch((error) =>
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  )
