import { mkdir, mkdtemp, rm, writeFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createOcrPicturesHost } from '../src/main/translate/ocr-pictures'
import { pruneOcrWorkDir } from '../src/main/translate/ocr-chat-source'
import { isAdHocDir } from '../src/main/translate/adhoc-dirs'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ocr-pictures-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3000, 1)])

/** A workbook whose sheet carries floating pictures anchored at the given zero-based rows. */
async function workbook(name: string, rows: number[]): Promise<string> {
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    '<workbook><sheets><sheet name="Webtoon" r:id="s1"/></sheets></workbook>',
  )
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="s1" Target="worksheets/sheet1.xml"/></Relationships>',
  )
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><drawing r:id="d"/></worksheet>')
  zip.file(
    'xl/worksheets/_rels/sheet1.xml.rels',
    '<Relationships><Relationship Id="d" Target="../drawings/drawing1.xml"/></Relationships>',
  )
  zip.file(
    'xl/drawings/drawing1.xml',
    `<xdr:wsDr>${rows
      .map(
        (row, i) =>
          `<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:row>${row}</xdr:row></xdr:from><xdr:pic><a:blip r:embed="im${i}"/></xdr:pic></xdr:oneCellAnchor>`,
      )
      .join('')}</xdr:wsDr>`,
  )
  zip.file(
    'xl/drawings/_rels/drawing1.xml.rels',
    `<Relationships>${rows
      .map(
        (_, i) =>
          `<Relationship Id="im${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i + 1}.png"/>`,
      )
      .join('')}</Relationships>`,
  )
  rows.forEach((_, i) =>
    zip.file(`xl/media/image${i + 1}.png`, Buffer.concat([png, Buffer.from([i])])),
  )
  const path = join(dir, name)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  return path
}

const deps = (over: Record<string, unknown> = {}) => ({
  workDir: () => join(dir, 'work'),
  ocrMode: () => ({ kind: 'ai', provider: 'claude' }) as never,
  showOcr: vi.fn(() => true),
  ...over,
})

it('lists the pictures in document order with sheet, anchor cell and the total', async () => {
  const path = await workbook('a.xlsx', [6, 81, 156])
  const host = createOcrPicturesHost(deps())
  const listing = await host.list(path)
  expect(listing.total).toBe(3)
  expect(listing.pictures).toEqual([
    { index: 1, sheet: 'Webtoon', cell: 'A7' },
    { index: 2, sheet: 'Webtoon', cell: 'A82' },
    { index: 3, sheet: 'Webtoon', cell: 'A157' },
  ])
})

it('reads only: listing never changes the file and never asks the shell to show anything', async () => {
  const path = await workbook('a.xlsx', [6])
  const before = await stat(path)
  const d = deps()
  await createOcrPicturesHost(d).list(path)
  const after = await stat(path)
  expect(after.mtimeMs).toBe(before.mtimeMs)
  expect(d.showOcr).not.toHaveBeenCalled()
})

it('refuses formats that cannot hold pictures to read', async () => {
  const host = createOcrPicturesHost(deps())
  await expect(host.list(join(dir, 'a.csv'))).rejects.toThrow()
  await expect(host.open(join(dir, 'a.csv'))).rejects.toThrow()
})

it('opens the OCR popup for a workbook outside any project through a private project copy', async () => {
  const path = await workbook('owner.xlsx', [6, 81])
  const d = deps()
  const host = createOcrPicturesHost(d)
  const result = await host.open(path)
  expect(result.opened).toBe(true)
  expect(d.showOcr).toHaveBeenCalledTimes(1)
  const event = (d.showOcr.mock.calls[0] as unknown[])[0] as { dir: string; file: string }
  expect(event.file).toBe('owner.xlsx')
  expect(event.dir.startsWith(join(dir, 'work'))).toBe(true)
  // the private project is allowed for the OCR channels without being a listed project
  expect(isAdHocDir(event.dir)).toBe(true)
  // the original is untouched
  expect((await stat(path)).isFile()).toBe(true)
})

it('opens the popup on the project of a workbook that is already a project source', async () => {
  const d = deps()
  const host = createOcrPicturesHost(d)
  const first = await workbook('x.xlsx', [6])
  await host.open(first)
  const { dir: projectDir } = (d.showOcr.mock.calls[0] as unknown[])[0] as { dir: string }
  const second = join(projectDir, 'source', 'x.xlsx')
  const d2 = deps()
  await createOcrPicturesHost(d2).open(second)
  expect((d2.showOcr.mock.calls[0] as unknown[])[0]).toEqual({ dir: projectDir, file: 'x.xlsx' })
})

it('reports that the shell could not show the popup', async () => {
  const path = await workbook('a.xlsx', [6])
  const host = createOcrPicturesHost(deps({ showOcr: () => false }))
  expect((await host.open(path)).opened).toBe(false)
})

it('lets the translation channels read a private OCR project but no other unlisted folder', async () => {
  const { createTranslateHandlers } = await import('../src/main/translate/translate-ipc')
  const path = await workbook('a.xlsx', [6])
  const d = deps()
  await createOcrPicturesHost(d).open(path)
  const { dir: projectDir } = (d.showOcr.mock.calls[0] as unknown[])[0] as { dir: string }
  const handlers = createTranslateHandlers({
    settingsPath: () => join(dir, 'app-settings.json'),
    now: () => 0,
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  })
  expect((await handlers.getProject(projectDir)).sources.map((s) => s.file)).toEqual(['a.xlsx'])
  await expect(handlers.getProject(join(dir, 'elsewhere'))).rejects.toThrow()
})

it('removes private copies older than a week and keeps recent ones and loose files', async () => {
  const work = join(dir, 'work')
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const make = async (name: string, ageDays: number) => {
    await mkdir(join(work, name), { recursive: true })
    await writeFile(join(work, name, 'project.json'), '{}')
    const at = new Date(now - ageDays * day)
    await utimes(join(work, name), at, at)
  }
  await make('old', 8)
  await make('fresh', 1)
  await writeFile(join(work, 'note.txt'), 'x')
  expect(await pruneOcrWorkDir(work, now)).toBe(1)
  await expect(stat(join(work, 'old'))).rejects.toThrow()
  await expect(stat(join(work, 'fresh'))).resolves.toBeTruthy()
  await expect(stat(join(work, 'note.txt'))).resolves.toBeTruthy()
  expect(await pruneOcrWorkDir(join(dir, 'missing'), now)).toBe(0)
})

it('prunes old copies when a new private copy is made', async () => {
  const path = await workbook('b.xlsx', [1])
  const work = join(dir, 'work')
  await mkdir(join(work, 'stale'), { recursive: true })
  const at = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
  await utimes(join(work, 'stale'), at, at)
  await createOcrPicturesHost(deps()).open(path)
  await expect(stat(join(work, 'stale'))).rejects.toThrow()
})
