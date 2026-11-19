import type { FileHandle } from 'node:fs/promises'

export interface CfbFileReader {
  readonly entries: readonly { path: string; type: 'stream' | 'storage'; size: number }[]
  chunks(path: string): AsyncIterable<Buffer>
  prefix(path: string, length: number): Promise<Buffer>
}

const END = 0xfffffffe
const FREE = 0xffffffff
const FAT = 0xfffffffd
const DIFAT = 0xfffffffc
const MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const CHUNK = 1024 * 1024
// Metadata has a separate budget: even a sparse or cyclic file must not turn
// the pre-save inspection into an in-memory copy of the document.
const MAX_TABLE = 64 * 1024 * 1024
const MAX_DIRECTORY_ENTRIES = 65_536
const MAX_PATH_CHARS = 4 * 1024 * 1024
function invalid(): never {
  throw new Error('Invalid or oversized CFB metadata')
}

interface Node {
  name: string
  kind: number
  left: number
  right: number
  child: number
  start: number
  size: number
}

function bitmap(count: number) {
  const used = new Uint8Array(Math.ceil(count / 8))
  return (id: number) => {
    if (id >= count) invalid()
    const i = id >>> 3
    const mask = 1 << (id & 7)
    if (used[i]! & mask) invalid()
    used[i] = used[i]! | mask
  }
}

// On the validation walk claim() also rejects cycles and shared sectors.
// Later reads walk the checked, immutable allocation tables with the same limit.
function* chain(start: number, table: Buffer, expected?: number, claim?: (id: number) => void) {
  const limit = table.length / 4
  let count = 0
  for (let id = start; id !== END; id = table.readUInt32LE(id * 4)) {
    if (id >= limit || count >= (expected ?? limit)) invalid()
    claim?.(id)
    count++
    yield id
  }
  if (expected !== undefined && count !== expected) invalid()
}

/** Read-only CFB v3/v4. The caller owns the already-open file and closes it. */
export async function openCfbFile(file: FileHandle, size: number): Promise<CfbFileReader> {
  if (!Number.isSafeInteger(size) || size < 512 || (await file.stat()).size !== size) invalid()
  async function read(
    position: number,
    length: number,
    target?: Buffer,
    offset = 0,
  ): Promise<Buffer> {
    if (position < 0 || position + length > size) invalid()
    const data = target ?? Buffer.allocUnsafe(length)
    for (let n = 0; n < length;) {
      const { bytesRead } = await file.read(data, offset + n, length - n, position + n)
      if (!bytesRead) invalid()
      n += bytesRead
    }
    return data
  }
  const head = await read(0, 512)
  const version = head.readUInt16LE(26)
  const shift = head.readUInt16LE(30)
  if (
    !head.subarray(0, 8).equals(MAGIC) ||
    head.readUInt16LE(28) !== 0xfffe ||
    !((version === 3 && shift === 9) || (version === 4 && shift === 12)) ||
    head.readUInt16LE(32) !== 6 ||
    head.readUInt32LE(56) !== 4096
  )
    invalid()
  const sector = 2 ** shift
  const sectors = size / sector - 1
  if (!Number.isInteger(sectors) || sectors < 2 || sectors * 4 > MAX_TABLE) invalid()
  const physical = (id: number) => (id + 1) * sector
  const claimSector = bitmap(sectors)

  function* ranges(
    ids: Iterable<number>,
    unit: number,
    position: (id: number) => number,
    bytes = Infinity,
  ) {
    let start = 0,
      length = 0
    for (const id of ids) {
      if (!bytes) break
      const pos = position(id)
      const n = Math.min(unit, bytes)
      if (length && (pos !== start + length || length + n > CHUNK)) {
        yield { start, length }
        length = 0
      }
      if (!length) start = pos
      length += n
      bytes -= n
    }
    if (length) yield { start, length }
  }

  async function* blocks(runs: Iterable<{ start: number; length: number }>) {
    for (const run of runs) yield await read(run.start, run.length)
  }

  async function collect(runs: Iterable<{ start: number; length: number }>, length: number) {
    const buffer = Buffer.allocUnsafe(length)
    let at = 0
    for (const run of runs) {
      await read(run.start, run.length, buffer, at)
      at += run.length
    }
    if (at !== length) invalid()
    return buffer
  }

  function readTable(ids: Iterable<number>, length: number) {
    if (length > MAX_TABLE) invalid()
    return collect(ranges(ids, sector, physical, length), length)
  }

  // The header carries the first 109 FAT sector IDs. Larger files continue
  // that list in DIFAT sectors; their last word points to the next DIFAT.
  const fatCount = head.readUInt32LE(44)
  const difatCount = head.readUInt32LE(72)
  if (
    fatCount < Math.ceil((sectors * 4) / sector) ||
    fatCount * sector > MAX_TABLE ||
    difatCount * sector > MAX_TABLE ||
    fatCount + difatCount > sectors
  )
    invalid()
  const fats: number[] = [],
    difats: number[] = []
  function fatIds(data: Buffer, from: number, end: number) {
    for (let off = from; off < end; off += 4) {
      const id = data.readUInt32LE(off)
      if (fats.length === fatCount) {
        if (id !== FREE) invalid()
        continue
      }
      claimSector(id)
      fats.push(id)
    }
  }
  fatIds(head, 76, 512)
  let dif = head.readUInt32LE(68)
  for (let i = 0; i < difatCount; i++) {
    claimSector(dif)
    difats.push(dif)
    const data = await read(physical(dif), sector)
    fatIds(data, 0, sector - 4)
    dif = data.readUInt32LE(sector - 4)
  }
  if (dif !== END || fats.length !== fatCount) invalid()
  const fat = await readTable(fats, sectors * 4)
  for (const id of fats) if (fat.readUInt32LE(id * 4) !== FAT) invalid()
  for (const id of difats) if (fat.readUInt32LE(id * 4) !== DIFAT) invalid()

  const dirCount = head.readUInt32LE(40)
  if (version === 3 && dirCount !== 0) invalid()
  const dir = chain(head.readUInt32LE(48), fat, version === 4 ? dirCount : undefined, claimSector)
  const nodes = new Map<number, Node>()
  let slot = 0
  for await (const data of blocks(ranges(dir, sector, physical))) {
    for (let off = 0; off < data.length; off += 128, slot++) {
      if (slot >= MAX_DIRECTORY_ENTRIES) invalid()
      const kind = data[off + 66]!
      if (!kind) continue
      if (kind !== 1 && kind !== 2 && !(slot === 0 && kind === 5)) invalid()
      const len = data.readUInt16LE(off + 64)
      if (len < 4 || len > 64 || len % 2 || data.readUInt16LE(off + len - 2)) invalid()
      const name = data.toString('utf16le', off, off + len - 2)
      if (name.includes('/') || name.includes('\0')) invalid()
      const bytes =
        version === 3 ? data.readUInt32LE(off + 120) : Number(data.readBigUInt64LE(off + 120))
      if (!Number.isSafeInteger(bytes) || bytes > size) invalid()
      nodes.set(slot, {
        name,
        kind,
        size: bytes,
        start: data.readUInt32LE(off + 116),
        left: data.readUInt32LE(off + 68),
        right: data.readUInt32LE(off + 72),
        child: data.readUInt32LE(off + 76),
      })
    }
  }
  const root = nodes.get(0)
  if (!root || root.kind !== 5 || root.left !== FREE || root.right !== FREE || root.size % 64)
    invalid()

  const miniCount = root.size / 64
  const miniFatCount = head.readUInt32LE(64)
  if (miniCount * 4 > miniFatCount * sector || miniFatCount * sector > MAX_TABLE) invalid()
  const rootSectors = Array.from(chain(root.start, fat, Math.ceil(root.size / sector), claimSector))
  // Count/check the whole declared miniFAT even if its last sectors are unused.
  const miniFats = Array.from(chain(head.readUInt32LE(60), fat, miniFatCount, claimSector))
  const miniFat = await readTable(miniFats, miniCount * 4)
  const claimMini = bitmap(miniCount)
  const miniPosition = (id: number) =>
    physical(rootSectors[Math.floor((id * 64) / sector)]!) + ((id * 64) % sector)

  const streams = new Map<string, Node>()
  const entries: { path: string; type: 'stream' | 'storage'; size: number }[] = []
  const seen = new Set<number>([0]),
    paths = new Set<string>()
  const pending = [{ id: root.child, parent: '' }]
  let pathChars = 0
  while (pending.length) {
    const { id, parent } = pending.pop()!
    if (id === FREE) continue
    const node = nodes.get(id)
    if (!node || seen.has(id)) invalid()
    seen.add(id)
    const path = parent + '/' + node.name
    pathChars += path.length
    if (pathChars > MAX_PATH_CHARS || paths.has(path)) invalid()
    paths.add(path)
    pending.push({ id: node.left, parent }, { id: node.right, parent })
    const stream = node.kind === 2
    entries.push({ path, type: stream ? 'stream' : 'storage', size: stream ? node.size : 0 })
    if (!stream) {
      pending.push({ id: node.child, parent: path })
      continue
    }
    if (node.child !== FREE) invalid()
    // SheetJS writes zero in the unused start field of an empty stream.
    if (!node.size && (node.start === 0 || node.start === FREE)) node.start = END
    streams.set(path, node)
    const mini = node.size < 4096
    const ids = chain(
      node.start,
      mini ? miniFat : fat,
      Math.ceil(node.size / (mini ? 64 : sector)),
      mini ? claimMini : claimSector,
    )
    // Validate the declared extent independently of how many bytes the caller
    // asks to read. No stream payload (including the root mini stream) is read.
    for (const _id of ids) {
      /* exhaust the checked chain */
    }
  }
  if (seen.size !== nodes.size) invalid()

  function stream(path: string) {
    const node = streams.get(path)
    if (!node) throw new Error('Unknown CFB stream: ' + path)
    return node
  }
  function streamRanges(node: Node, length: number) {
    const mini = node.size < 4096
    const unit = mini ? 64 : sector
    return ranges(
      chain(node.start, mini ? miniFat : fat, Math.ceil(node.size / unit)),
      unit,
      mini ? miniPosition : physical,
      length,
    )
  }
  return {
    entries,
    chunks: (path) => {
      const node = stream(path)
      return blocks(streamRanges(node, node.size))
    },
    async prefix(path, length) {
      if (!Number.isSafeInteger(length) || length < 0) invalid()
      const node = stream(path)
      const n = Math.min(length, node.size)
      return collect(streamRanges(node, n), n)
    },
  }
}
