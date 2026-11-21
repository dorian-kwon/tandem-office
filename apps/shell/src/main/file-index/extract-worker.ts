import { workerData } from 'node:worker_threads'
import { SidecarInfraError, isParseSidecarEnabled } from '@genoffice/file-parse'
import { extractText } from './extract'
import { scanFiles, type ScanResult } from './scan'
import { IndexParserClient } from './native-parser'
import { runIndexWorker } from './worker'

// This process belongs exclusively to the serialized index writer. Redaction
// fallbacks never borrow the interactive attachment process or write on main.
const sidecar = new IndexParserClient(workerData.parserPort)
async function scan(root: string): Promise<ScanResult> {
  if (isParseSidecarEnabled()) {
    try {
      const result = await sidecar.scanDir({ root })
      return { files: [...result.files], truncated: result.truncated }
    } catch (error) {
      if (
        !(error instanceof SidecarInfraError) ||
        error.code === 'stopped' ||
        error.code === 'request_timeout'
      )
        throw error
    }
  }
  return scanFiles(root)
}

runIndexWorker((path) => extractText(path, sidecar), scan)
