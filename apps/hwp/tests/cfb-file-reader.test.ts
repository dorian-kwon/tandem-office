import { mkdtemp, open, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import * as CFB from 'cfb'
import { describe, expect, it, vi } from 'vitest'
import { openCfbFile } from '../src/main/cfb-file-reader'

const END = 0xfffffffe,
  FREE = 0xffffffff
const sector = 4096
const at = (id: number) => sector * (id + 1)

async function withFile(data: Buffer, test: (fd: FileHandle) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'hwp-cfb-'))
  try {
    const path = join(dir, 'file.hwp')
    await writeFile(path, data)
    const file = await open(path, 'r')
    try {
      await test(file)
    } finally {
      await file.close()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function contents(parts: AsyncIterable<Buffer>) {
  const blocks: Buffer[] = []
  for await (const block of parts) blocks.push(block)
  return Buffer.concat(blocks)
}

// A v4 compound file with two noncontiguous sectors in both the large image
// and the root mini stream. The header's mini chain crosses that root boundary.
function v4() {
  const file = Buffer.alloc(at(8))
  const u32 = (p: number, n: number) => file.writeUInt32LE(n, p)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(file)
  file.writeUInt16LE(0x3e, 24)
  file.writeUInt16LE(4, 26)
  file.writeUInt16LE(0xfffe, 28)
  file.writeUInt16LE(12, 30)
  file.writeUInt16LE(6, 32)
  u32(40, 1)
  u32(44, 1)
  u32(48, 1)
  u32(56, 4096)
  u32(60, 2)
  u32(64, 1)
  u32(68, END)
  file.fill(0xff, 76, 512)
  u32(76, 0)
  file.fill(0xff, at(0), at(1))
  for (const [i, next] of [0xfffffffd, END, END, 7, 6, FREE, END, END].entries())
    u32(at(0) + 4 * i, next)
  function entry(
    id: number,
    name: string,
    kind: number,
    start: number,
    size: number,
    child = FREE,
    right = FREE,
  ) {
    const off = at(1) + id * 128
    file.write(name, off, 'utf16le')
    file.writeUInt16LE((name.length + 1) * 2, off + 64)
    file[off + 66] = kind
    file[off + 67] = 1
    u32(off + 68, FREE)
    u32(off + 72, right)
    u32(off + 76, child)
    u32(off + 116, start)
    u32(off + 120, size)
  }
  entry(0, 'Root Entry', 5, 3, 65 * 64, 1)
  entry(1, 'BinData', 1, 0, 0, 3, 2)
  entry(2, 'FileHeader', 2, 64, 72)
  entry(3, 'BIN0001.bmp', 2, 4, sector + 99)
  file.fill(0xff, at(2), at(3))
  u32(at(2) + 64 * 4, 0)
  u32(at(2), END)
  file.fill(0x41, at(7), at(7) + 64)
  file.fill(0x42, at(3), at(3) + 8)
  file.fill(0x43, at(4), at(5))
  file.fill(0x44, at(6), at(6) + 99)
  return file
}

describe('file-backed CFB streams', () => {
  it('reads every storage path and stream of a v3 HWP like the existing parser', async () => {
    const bytes = await readFile(resolve(__dirname, 'fixtures/memo-source.hwp'))
    const original = CFB.read(bytes, { type: 'buffer' })
    await withFile(bytes, async (fd) => {
      const reader = await openCfbFile(fd, bytes.length)
      const expected = original.FileIndex.flatMap((entry, i) => {
        if (entry.type !== 1 && entry.type !== 2) return []
        return [
          {
            path:
              '/' + original.FullPaths[i]!.slice(original.FullPaths[0]!.length).replace(/\/$/, ''),
            type: entry.type === 1 ? 'storage' : 'stream',
            size: entry.type === 1 ? 0 : entry.size,
          },
        ]
      })
      expect(reader.entries).toHaveLength(expected.length)
      for (const entry of expected) {
        expect(reader.entries).toContainEqual(entry)
        if (entry.type === 'stream')
          expect(await contents(reader.chunks(entry.path))).toEqual(
            Buffer.from(CFB.find(original, entry.path)!.content as Uint8Array),
          )
      }
    })
  })

  it('uses exact paths and preserves fragmented 4KiB and 64-byte chain order', async () => {
    const file = v4()
    await withFile(file, async (fd) => {
      const reader = await openCfbFile(fd, file.length)
      expect(reader.entries.map((e) => e.path).sort()).toEqual([
        '/BinData',
        '/BinData/BIN0001.bmp',
        '/FileHeader',
      ])
      expect(await contents(reader.chunks('/FileHeader'))).toEqual(
        Buffer.concat([Buffer.alloc(64, 0x41), Buffer.alloc(8, 0x42)]),
      )
      expect(await contents(reader.chunks('/BinData/BIN0001.bmp'))).toEqual(
        Buffer.concat([Buffer.alloc(sector, 0x43), Buffer.alloc(99, 0x44)]),
      )
      expect(await reader.prefix('/FileHeader', 65)).toEqual(
        Buffer.concat([Buffer.alloc(64, 0x41), Buffer.alloc(1, 0x42)]),
      )
      await expect(reader.prefix('/fileheader', 5)).rejects.toThrow()
      await expect(reader.prefix('/BinData', 5)).rejects.toThrow()
    })
  })

  it('follows DIFAT beyond 109 FAT sectors, reads only metadata for a prefix and batches large reads', async () => {
    const image = Buffer.alloc(8 * 1024 * 1024, 0x4b)
    const cfb = CFB.utils.cfb_new()
    CFB.utils.cfb_add(cfb, '/BinData/BIN0001.bmp', image)
    CFB.utils.cfb_add(cfb, '/Empty', Buffer.alloc(0))
    const bytes = CFB.write(cfb, { type: 'buffer' }) as Buffer
    expect(bytes.readUInt32LE(72)).toBeGreaterThan(0)
    await withFile(bytes, async (fd) => {
      const reads = vi.spyOn(fd, 'read')
      const reader = await openCfbFile(fd, bytes.length)
      expect(reads.mock.calls.reduce((n, args) => n + Number(args[2]), 0)).toBeLessThan(100 * 1024)
      reads.mockClear()
      expect(await reader.prefix('/BinData/BIN0001.bmp', 14)).toEqual(image.subarray(0, 14))
      expect(reads.mock.calls.map((args) => args[2])).toEqual([14])
      expect(await contents(reader.chunks('/Empty'))).toHaveLength(0)
      reads.mockClear()
      const prefix = await reader.prefix('/BinData/BIN0001.bmp', 3 * 1024 * 1024)
      expect(prefix.equals(image.subarray(0, prefix.length))).toBe(true)
      expect(reads.mock.calls).toHaveLength(3)
      expect(reads.mock.calls.every((args) => args[0] === prefix)).toBe(true)
      reads.mockClear()
      const whole = await contents(reader.chunks('/BinData/BIN0001.bmp'))
      expect(whole.equals(image)).toBe(true)
      expect(reads.mock.calls.length).toBe(8)
      expect(Math.max(...reads.mock.calls.map((args) => Number(args[2])))).toBeLessThanOrEqual(
        1024 * 1024,
      )
    })
  })

  it('rejects a stale file extent before returning a prefix from the surviving bytes', async () => {
    const file = v4()
    await withFile(file.subarray(0, file.length - sector), async (fd) => {
      await expect(openCfbFile(fd, file.length)).rejects.toThrow(/CFB/)
    })
  })

  it.each([
    ['regular chain cut short', at(0) + 4 * 4, END],
    ['regular chain cycles beyond requested prefix', at(0) + 6 * 4, 4],
    ['regular sector outside file', at(0) + 4 * 4, 8000],
    ['mini chain cycles', at(2) + 64 * 4, 64],
    ['mini sector outside root extent', at(2) + 64 * 4, 80],
    ['directory sibling cycle', at(1) + 128 + 72, 1],
    ['64-bit stream extent past EOF', at(1) + 3 * 128 + 124, 1],
    ['incorrect FAT type marker', at(0), END],
    ['missing DIFAT sector', 72, 1],
  ] as const)('rejects %s even when reading a 14-byte prefix', async (_why, offset, value) => {
    const bytes = v4()
    bytes.writeUInt32LE(value, offset)
    await withFile(bytes, async (fd) => {
      const prefix = async () =>
        (await openCfbFile(fd, bytes.length)).prefix('/BinData/BIN0001.bmp', 14)
      await expect(prefix()).rejects.toThrow(/CFB/)
    })
  })
})
