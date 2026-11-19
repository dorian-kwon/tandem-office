import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'

const WORKER = join(__dirname, 'file-index-test-worker.mjs')

describe('FileIndexer when a parse exhausts the worker heap', () => {
  it('records the file as an error, keeps indexing, and does not retry it unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-oom-'))
    const storeDir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-oom-db-'))
    let indexer: FileIndexer | undefined
    const store = new FileIndexStore(join(storeDir, 'index.db'))
    try {
      const hog = join(dir, 'hog.xlsx')
      const notes = join(dir, 'notes.md')
      writeFileSync(hog, 'x')
      writeFileSync(notes, 'y')
      indexer = new FileIndexer(
        store.dbPath,
        WORKER,
        { roots: () => [dir], extraPaths: () => [] },
        30_000,
        32,
      )
      await indexer.scan()
      await vi.waitFor(
        () => {
          expect(indexer!.progress()).toMatchObject({ pending: 0, scanning: false })
          expect(store.listAll().get(notes)?.status).toBe('ok')
        },
        { timeout: 20_000, interval: 50 },
      )
      expect(store.listAll().get(hog)?.status).toBe('error')

      const ask = vi.spyOn(indexer as unknown as { ask: (r: unknown) => unknown }, 'ask')
      await indexer.scan()
      await vi.waitFor(
        () => {
          expect(indexer!.progress()).toMatchObject({ pending: 0, scanning: false })
        },
        { timeout: 5_000, interval: 25 },
      )
      const extracted = ask.mock.calls.filter((c) => (c[0] as { type: string }).type === 'index')
      expect(extracted).toHaveLength(0)
    } finally {
      await indexer?.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
      rmSync(storeDir, { recursive: true, force: true })
    }
  }, 30_000)
})
