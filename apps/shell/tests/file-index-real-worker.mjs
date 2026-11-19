// Node's worker loader does not run Vitest's TypeScript transform.
import { require as loadTs } from 'tsx/cjs/api'
loadTs('../src/main/file-index/extract-worker.ts', import.meta.url)
