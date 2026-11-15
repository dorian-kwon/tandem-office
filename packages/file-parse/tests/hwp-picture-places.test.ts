import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { hwpPicturePlaces } from '../src/hwp'

/**
 * Where the pictures of a Hangul document stand once the engine has laid it out: the page of each
 * and its place on that page, in reading order. The documents are the editor's own test files.
 */

const root = join(__dirname, '..', '..', '..')
const fixture = (...path: string[]) => new Uint8Array(readFileSync(join(root, ...path)))
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe('the pictures of a laid-out Hangul document', () => {
  it('gives a picture of a HWPX document its page and the hash of its bytes', async () => {
    const bytes = fixture('apps/hwp/tests/fixtures/square-picture-after-page-reset.hwpx')
    const places = await hwpPicturePlaces(bytes)
    expect(places).toHaveLength(1)
    expect(places[0]!.page).toBe(2)
    const zip = await JSZip.loadAsync(bytes)
    const names = Object.keys(zip.files).filter((n) => /^BinData\/.*\.(png|jpe?g)$/i.test(n))
    const hashes = await Promise.all(
      names.map(async (n) => sha256(await zip.file(n)!.async('uint8array'))),
    )
    expect(hashes).toContain(places[0]!.sha256)
  })

  it('reads a HWP 5 document the same way', async () => {
    const places = await hwpPicturePlaces(fixture('e2e/assets/hwp-picture-table.hwp'))
    expect(places.map((p) => p.page)).toEqual([1])
    expect(places[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lists the pictures of a long document in page order, with those of table cells', async () => {
    const places = await hwpPicturePlaces(fixture('apps/hwp/tests/fixtures/memo-source.hwp'))
    // 6 pictures in the body and 10 in table cells, each once: the header's picture, which is
    // drawn on all 40 pages and cannot be taken out, is not among them
    expect(places).toHaveLength(16)
    const pages = places.map((p) => p.page)
    expect(pages).toEqual([...pages].sort((a, b) => a - b))
    expect(pages[0]).toBe(1)
    expect(Math.max(...pages)).toBeLessThanOrEqual(40)
  })

  it('lists a picture that stands on several pages once, on the first', async () => {
    const places = await hwpPicturePlaces(
      fixture('apps/hwp/tests/fixtures/master-page-duplex-both.hwpx'),
    )
    // the engine reports it on both pages of this document; it is one picture
    const keys = places.map((p) => p.sha256)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('refuses bytes that are not a Hangul document', async () => {
    await expect(hwpPicturePlaces(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow()
  })
})
