import { parentPort, workerData } from 'node:worker_threads'
import type { Extracted } from './extract'
import { scanFiles, statOrNull, type ScannedFile, type ScanResult } from './scan'
import { FileIndexStore } from './store'

export type WorkerRequest =
  | { type: 'open' }
  | { type: 'scan'; root: string }
  | { type: 'remove'; paths: string[] }
  | { type: 'index'; file: ScannedFile; mode: 'extract' | 'cloud' | 'error' }

export type WorkerResponse =
  { type: 'done' | 'changed' | 'failed' } | ({ type: 'scan' } & ScanResult)

export function runIndexWorker(
  extract: (path: string) => Promise<Extracted>,
  scan: (root: string) => ScanResult | Promise<ScanResult> = scanFiles,
): void {
  const port = parentPort!
  const store = new FileIndexStore(workerData.dbPath)
  port.on('close', () => store.close())

  async function index(req: Extract<WorkerRequest, { type: 'index' }>): Promise<WorkerResponse> {
    const { file, mode } = req
    function checkDisk(): WorkerResponse | undefined {
      const now = statOrNull(file.path)
      if (!now) {
        store.remove([file.path])
        return { type: 'done' }
      }
      if (file.mtimeMs !== now.mtimeMs || file.sizeBytes !== now.sizeBytes)
        return { type: 'changed' }
    }
    const before = checkDisk()
    if (before) return before
    if (mode !== 'extract') {
      if (mode === 'error') store.recordInterruptedExtraction(file)
      else store.upsert(file, null, mode)
      return { type: 'done' }
    }
    const result = await extract(file.path)
    const after = checkDisk()
    if (after) return after
    if (result.kind === 'text') store.upsert(file, result.text, 'ok', result.tokens)
    else store.upsert(file, null, result.kind)
    return { type: 'done' }
  }

  // The coordinator posts one request at a time and waits for its commit.
  port.on('message', async (req: WorkerRequest) => {
    let response: WorkerResponse = { type: 'done' }
    try {
      if (req.type === 'scan') response = { type: 'scan', ...(await scan(req.root)) }
      else if (req.type === 'remove') store.remove(req.paths)
      else if (req.type === 'index') response = await index(req)
    } catch {
      // A failed write rolls back in the store. A later scan can retry it.
      response = { type: 'failed' }
    }
    port.postMessage(response)
  })
}
