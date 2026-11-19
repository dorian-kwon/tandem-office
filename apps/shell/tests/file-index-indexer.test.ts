import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'

// the worker double never answers the extraction for poison.pdf, so these tests
// only pass once a wedged request fails on timeout and the queue moves on to
// the files behind it
const WORKER = join(__dirname, 'file-index-test-worker.mjs')

let dir: string
let storeDir: string
let store: FileIndexStore
let indexer: FileIndexer | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-'))
  storeDir = mkdtempSync(join(tmpdir(), 'genoffice-indexer-db-'))
  mkdirSync(join(dir, 'hang'))
  writeFileSync(join(dir, 'hang', 'poison.pdf'), 'unparseable')
  writeFileSync(join(dir, 'hang', 'z-following.md'), 'after the wedged parse')
  mkdirSync(join(dir, 'good'))
  writeFileSync(join(dir, 'good', 'notes.md'), 'searchable body text')
  store = new FileIndexStore(join(storeDir, 'index.db'))
})
afterEach(async () => {
  await indexer?.stop()
  indexer = null
  store.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(storeDir, { recursive: true, force: true })
})

const indexerWithShortTimeout = () =>
  new FileIndexer(store.dbPath, WORKER, { roots: () => [dir], extraPaths: () => [] }, 2000)

const notesPath = () => join(dir, 'good', 'notes.md')
const poisonPath = () => join(dir, 'hang', 'poison.pdf')

describe('FileIndexer wedged-worker recovery', () => {
  it('fails a hung extraction on timeout and keeps indexing the rest of the queue', async () => {
    indexer = indexerWithShortTimeout()
    const started = Date.now()
    await indexer.scan()
    expect(store.listAll().get(poisonPath())?.status).toBe('error')
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
    expect(store.listAll().get(join(dir, 'hang', 'z-following.md'))?.status).toBe('ok')
    expect(indexer.progress()).toMatchObject({ pending: 0, scanning: false })
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000)
  })

  it('still runs scans and extractions after a timed-out request', async () => {
    indexer = indexerWithShortTimeout()
    await indexer.scan()
    await vi.waitFor(
      () => {
        expect(indexer!.progress().pending).toBe(0)
      },
      { timeout: 5_000, interval: 25 },
    )
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
    // an unchanged error row is not re-queued; the rescan itself must not wedge
    await indexer.scan()
    await vi.waitFor(
      () => {
        expect(indexer!.progress()).toMatchObject({ pending: 0, scanning: false })
      },
      { timeout: 5_000, interval: 25 },
    )
    expect(store.listAll().get(notesPath())?.status).toBe('ok')
  })
})

describe('FileIndexer while a file is being parsed', () => {
  it('rolls back a failed replacement and retries it on the next scan', async () => {
    rmSync(join(dir, 'hang'), { recursive: true })
    store.upsert({ path: notesPath(), sizeBytes: 1, mtimeMs: 1 }, 'previous version', 'ok')
    const db = new DatabaseSync(store.dbPath)
    try {
      db.exec(
        "CREATE TRIGGER fail_index BEFORE INSERT ON files BEGIN SELECT RAISE(FAIL, 'injected'); END",
      )
      indexer = new FileIndexer(store.dbPath, WORKER, { roots: () => [dir], extraPaths: () => [] })
      await indexer.scan()
      expect(store.search('previous').hits[0]?.path).toBe(notesPath())
      expect(store.pathsIndexedAsOnDisk([notesPath()])).toEqual([])
      db.exec('DROP TRIGGER fail_index')
      await indexer.scan()
      expect(store.search('previous').total).toBe(0)
      expect(store.pathsIndexedAsOnDisk([notesPath()])).toEqual([notesPath()])
    } finally {
      db.close()
    }
  })

  function startPaused() {
    const path = join(dir, 'paused.md')
    writeFileSync(path, 'outdated')
    const roots = [dir]
    rmSync(join(dir, 'hang'), { recursive: true })
    indexer = new FileIndexer(store.dbPath, WORKER, { roots: () => roots, extraPaths: () => [] })
    const scan = indexer.scan()
    const started = vi.waitFor(() => expect(existsSync(path + '.started')).toBe(true), {
      timeout: 5000,
    })
    return { path, roots, scan, started }
  }

  it('restarts with fresh metadata when the file changes during extraction', async () => {
    const { path, scan, started } = startPaused()
    await started
    writeFileSync(path, 'replacement text')
    writeFileSync(path + '.release', '')
    await scan
    expect(store.search('outdated').total).toBe(0)
    expect(store.search('replacement').hits.map((f) => f.path)).toEqual([path])
  })

  it('removes rows from a withdrawn root after the in-flight write', async () => {
    const { path, roots, scan, started } = startPaused()
    await started
    roots.length = 0
    void indexer!.scan()
    writeFileSync(path + '.release', '')
    await scan
    expect(store.count()).toBe(0)
  })

  it('stops a pending parse without opening a replacement worker or recording an error row', async () => {
    const { path, scan, started } = startPaused()
    await started
    await indexer!.stop()
    await scan
    expect(store.listAll().has(path)).toBe(false)
    expect(await indexer!.open()).toBeNull()
  })
})
