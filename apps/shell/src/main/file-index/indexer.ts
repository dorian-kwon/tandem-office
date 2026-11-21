import { MessageChannel, Worker } from 'node:worker_threads'
import { extname } from 'node:path'
import { hostIndexParser } from './native-parser'
import { resolveParseSidecarPath } from '@genoffice/file-parse/sidecar-path'
import { INDEX_STREAMING_EXTS, MAX_EXTRACT_BYTES } from './limits'
import type { WorkerRequest, WorkerResponse } from './worker'
import { isSupportedTreeFile } from '../folder-tree'
import { statOrNull, type ScannedFile } from './scan'
import { FileIndexStore } from './store'

export interface IndexProgress {
  /** files currently in the index */
  indexed: number
  /** files waiting for extraction */
  pending: number
  scanning: boolean
}

export interface IndexerSources {
  /** the folders walked recursively: the save folder and every added root */
  roots: () => readonly string[]
  /** files outside the roots that should still be searchable (recents, starred) */
  extraPaths: () => readonly string[]
  /**
   * Of the files a scan is about to (re)index, those to index by name only
   * because their content is not on this PC (project folders, spec 5.8). Asked
   * once per scan with the whole batch; extracting such a file would download
   * it. Absent: every file is extracted, as before.
   */
  nameOnly?: (paths: readonly string[]) => Promise<ReadonlySet<string>>
}

const RESCAN_DEBOUNCE_MS = 1500
/**
 * a worker request left unanswered this long means a wedged parse or a stalled
 * walk: the request fails as an extraction error and the worker is recycled,
 * so one bad file cannot stall indexing (and search with it) for good
 */
const WORKER_REQUEST_TIMEOUT_MS = 120_000
/**
 * heap cap for the extraction worker: without resourceLimits a parse that
 * exhausts V8's heap is a process-wide fatal OOM and takes the whole app down
 * with it; with one, only the worker dies and the file is recorded as an error
 */
const WORKER_HEAP_LIMIT_MB = 1024

/**
 * A scan, its removals and its file writes finish in order. Another refresh
 * can supersede the remaining files after the current worker request settles.
 */
export class FileIndexer {
  private worker: Worker | null = null
  private nativeHost: ReturnType<typeof hostIndexParser> | null = null
  private retiring: Promise<number> | null = null
  private waiting: ((r: WorkerResponse | { type: 'lost' }) => void) | null = null
  private reader: FileIndexStore | null = null
  private opening: Promise<FileIndexStore | null> | null = null
  private pending = 0
  private scanning = false
  private scanRequested = false
  private rescanTimer: NodeJS.Timeout | null = null
  private lastScanAt = 0
  private stopped = false

  constructor(
    private readonly dbPath: string,
    private readonly workerPath: string,
    private readonly sources: IndexerSources,
    private readonly requestTimeoutMs = WORKER_REQUEST_TIMEOUT_MS,
    private readonly workerHeapLimitMb = WORKER_HEAP_LIMIT_MB,
  ) {}

  /** Only expose a reader after the writer has rebuilt any outdated index. */
  async open(): Promise<FileIndexStore | null> {
    if (this.stopped || this.reader) return this.reader
    this.opening ??= this.ask({ type: 'open' })
      .then((r) => {
        if (this.stopped || r.type !== 'done') return null
        this.reader = new FileIndexStore(this.dbPath, { readOnly: true })
        return this.reader
      })
      .catch(() => null)
      .finally(() => {
        this.opening = null
      })
    return this.opening
  }

  progress(): IndexProgress {
    return { indexed: this.reader?.count() ?? 0, pending: this.pending, scanning: this.scanning }
  }

  /** schedule a scan soon; repeated calls within the debounce window fold into one */
  refresh(): void {
    if (this.stopped) return
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.scan()
    }, RESCAN_DEBOUNCE_MS)
  }

  refreshIfStale(maxAgeMs: number): void {
    if (!this.scanning && Date.now() - this.lastScanAt >= maxAgeMs) void this.scan()
  }

  async scan(): Promise<void> {
    if (this.stopped) return
    if (this.scanning) {
      this.scanRequested = true
      return
    }
    this.scanning = true
    try {
      const reader = await this.open()
      if (!reader) return
      do {
        this.scanRequested = false
        if (await this.scanOnce(reader)) this.lastScanAt = Date.now()
      } while (this.scanRequested && !this.stopped)
    } finally {
      this.pending = 0
      this.scanning = false
    }
  }

  private async scanOnce(reader: FileIndexStore): Promise<boolean> {
    const seen = new Map<string, ScannedFile>()
    let complete = true
    for (const root of this.sources.roots()) {
      const res = await this.ask({ type: 'scan', root })
      if (res.type !== 'scan') return false
      for (const f of res.files) seen.set(f.path, f)
      if (res.truncated) complete = false
    }
    for (const p of this.sources.extraPaths()) {
      if (seen.has(p) || !isSupportedTreeFile(p)) continue
      const st = statOrNull(p)
      if (st) seen.set(p, st)
    }
    if (this.stopped) return false
    const known = reader.listAll()
    // A capped walk cannot tell a vanished file from one it never reached.
    if (complete) {
      const gone = [...known.keys()].filter((p) => !seen.has(p))
      if (gone.length && (await this.ask({ type: 'remove', paths: gone })).type !== 'done')
        return false
    }
    const changed: ScannedFile[] = []
    const recheck: ScannedFile[] = []
    for (const f of seen.values()) {
      const k = known.get(f.path)
      if (k && k.mtimeMs === f.mtimeMs && k.sizeBytes === f.sizeBytes) {
        if (
          k.status === 'cloud' ||
          (k.status === 'name-only' &&
            k.sizeBytes > MAX_EXTRACT_BYTES &&
            INDEX_STREAMING_EXTS.has(extname(f.path).slice(1).toLowerCase()))
        )
          recheck.push(f)
      } else changed.push(f)
    }
    const nameOnly = await this.decideNameOnly([...changed, ...recheck])
    for (const f of recheck) if (!nameOnly.has(f.path)) changed.push(f)
    this.pending = changed.length
    for (const file of changed) {
      if (this.stopped || this.scanRequested) return false
      const mode = nameOnly.has(file.path) ? 'cloud' : 'extract'
      let res = await this.ask({ type: 'index', file, mode })
      if (res.type === 'lost' && mode === 'extract' && !this.stopped) {
        // A parse that killed or wedged the worker must not be run on every scan.
        res = await this.ask({ type: 'index', file, mode: 'error' })
      }
      this.pending--
      if (res.type === 'changed') this.scanRequested = true
    }
    return true
  }

  /** one call for the whole batch; a source that fails leaves every file name-only rather than extracted */
  private async decideNameOnly(files: readonly ScannedFile[]): Promise<ReadonlySet<string>> {
    const decide = this.sources.nameOnly
    if (!decide || files.length === 0) return new Set()
    try {
      return await decide(files.map((f) => f.path))
    } catch {
      return new Set(files.map((f) => f.path))
    }
  }

  private async ask(req: WorkerRequest): Promise<WorkerResponse | { type: 'lost' }> {
    // terminate() is asynchronous. Let the old writer release its transaction
    // before opening a replacement, including after a timed-out write.
    if (this.retiring) await this.retiring
    if (this.stopped) return { type: 'lost' }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.retire(), this.requestTimeoutMs)
      this.waiting = (response) => {
        clearTimeout(timer)
        this.waiting = null
        resolve(response)
      }
      try {
        this.ensureWorker().postMessage(req)
      } catch {
        this.retire()
      }
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    // Electron exposes resourcesPath on main but not necessarily in Node
    // worker threads. Resolve the installed helper before crossing that boundary.
    const { port1, port2 } = new MessageChannel()
    this.nativeHost = hostIndexParser(port1, resolveParseSidecarPath())
    const worker = new Worker(this.workerPath, {
      workerData: { dbPath: this.dbPath, parserPort: port2 },
      transferList: [port2],
      resourceLimits: { maxOldGenerationSizeMb: this.workerHeapLimitMb },
    })
    worker.on('message', (response: WorkerResponse) => {
      if (this.worker === worker) this.waiting?.(response)
    })
    const dropped = () => {
      if (this.worker === worker) this.retire()
    }
    worker.on('error', dropped)
    worker.on('exit', dropped)
    this.worker = worker
    return worker
  }

  private retire(): void {
    const worker = this.worker
    this.worker = null
    this.nativeHost?.stop()
    this.nativeHost = null
    if (worker) this.retiring = worker.terminate()
    this.waiting?.({ type: 'lost' })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.retire()
    this.reader?.close()
    this.reader = null
    await this.retiring
  }
}
