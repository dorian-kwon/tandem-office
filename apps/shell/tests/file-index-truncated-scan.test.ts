import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'

const WORKER = join(__dirname, 'file-index-test-worker.mjs')

describe('FileIndexer with a budget-capped scan', () => {
  it('keeps indexed entries the capped walk never reached', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-db-'))
    let indexer: FileIndexer | undefined
    const store = new FileIndexStore(join(storeDir, 'index.db'))
    try {
      const deep = join(storeDir, ...Array<string>(40).fill('level'))
      mkdirSync(deep, { recursive: true })
      const unreached = join(deep, 'notes.md')
      store.upsert({ path: unreached, mtimeMs: 1, sizeBytes: 1 }, 'body', 'ok')
      indexer = new FileIndexer(store.dbPath, WORKER, {
        roots: () => [storeDir],
        extraPaths: () => [],
      })
      await indexer.scan()
      expect(store.listAll().has(unreached)).toBe(true)
    } finally {
      await indexer?.stop()
      store.close()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})
