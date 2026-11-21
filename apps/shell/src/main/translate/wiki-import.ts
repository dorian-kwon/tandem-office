import { basename } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { Lang } from '@genoffice/i18n'
import { resolveParseSidecarPath, rhwpWasmPath } from '@genoffice/file-parse'
import type { WikiFinalResult } from '../../shared/translate-api'
import workerPath from './wiki-import-worker?modulePath'

export interface WikiImportOptions {
  profileDir: string
  lang: Lang
  cliEntry: string
}

export function learnFinalPaths(
  paths: string[],
  options: WikiImportOptions,
): Promise<WikiFinalResult[]> {
  // Keep the document bytes, parsed text and the WASM engine out of the UI process.
  // Retain each completed result even if a later input exhausts the worker.
  const results: WikiFinalResult[] = paths.map((path) => ({
    name: basename(path),
    status: 'failed',
  }))
  return new Promise((resolve) => {
    const worker = new Worker(workerPath, {
      workerData: { ...options, paths },
      env: {
        ...process.env,
        GENOFFICE_RHWP_WASM: rhwpWasmPath(),
        GENOFFICE_PARSE_SIDECAR_PATH: resolveParseSidecarPath() ?? '',
      },
    })
    worker.on(
      'message',
      ({ index, status }: { index: number; status: WikiFinalResult['status'] }) => {
        results[index]!.status = status
      },
    )
    worker.once('error', () => resolve(results))
    worker.once('exit', () => resolve(results))
  })
}
