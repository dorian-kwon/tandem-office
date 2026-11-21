import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { createXmindDocumentFromOutline, openXmind, sheetsToOutline } from '@genoffice/xmind-engine'
import { openEpub } from '@genoffice/epub-engine/core'
import { xlsxSidecarPath } from '../src/resources'
import { CONVERSION_ROUTES } from '../src/conversion-routes'
import { run, tempDir } from './helpers'

async function convert(input: string, target: string, output: string) {
  const result = await run(['convert', input, '--to', target, '--out', output, '--json'])
  expect(result.json().status, result.stdout).toBe('ok')
  return result.json()
}

describe('Hangul file conversions', () => {
  it('offers the reciprocal routes for each editable Hangul container', () => {
    for (const source of ['hwp', 'hwpx']) {
      for (const format of [
        'docx',
        'odt',
        'html',
        'md',
        'txt',
        'pdf',
        'pptx',
        'xlsx',
        'epub',
        'xmind',
      ]) {
        expect(CONVERSION_ROUTES[source]).toContain(format)
        expect(CONVERSION_ROUTES[format]).toContain(source)
      }
      expect(CONVERSION_ROUTES[source]).not.toContain(source)
    }
  })

  it('round trips a nested table through both native containers and keeps it editable as HTML', async () => {
    const dir = tempDir()
    const fixture = join(__dirname, '../../../apps/hwp/tests/fixtures/nested-depth2.hwp')
    const xml = join(dir, 'copy.hwpx')
    const binary = join(dir, 'roundtrip.hwp')
    const html = join(dir, 'body.html')
    await convert(fixture, 'hwpx', xml)
    await convert(xml, 'hwp', binary)
    await convert(binary, 'html', html)
    expect(readFileSync(xml).subarray(0, 2).toString()).toBe('PK')
    expect(readFileSync(binary).subarray(0, 4).toString('hex')).toBe('d0cf11e0')
    const body = readFileSync(html, 'utf8')
    expect(body.match(/<table\b/g)).toHaveLength(3)
    for (const value of ['0-3', '1-3', '2-3']) expect(body).toContain(value)
  })

  it('imports body paragraphs, a table and visible document text without including the HTML header', async () => {
    const dir = tempDir()
    const html = join(dir, 'source.html')
    writeFileSync(
      html,
      '<title>Ignore header</title><p>한글 &amp; English</p><table><tr><td>left</td><td>right</td></tr></table>',
    )
    const xml = join(dir, 'result.hwpx')
    const txt = join(dir, 'result.txt')
    const result = await convert(html, 'hwpx', xml)
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'body_conversion' }))
    await convert(xml, 'txt', txt)
    const text = readFileSync(txt, 'utf8')
    expect(text).toContain('한글 & English')
    expect(text).toContain('left | right')
    expect(text).not.toContain('Ignore header')
  })

  it('exports an EPUB with a packaged image, then imports both spine chapters in order', async () => {
    const dir = tempDir()
    const fixture = join(__dirname, '../../../e2e/assets/hwp-picture-table.hwp')
    const ebook = join(dir, 'book.epub')
    const hwpx = join(dir, 'book.hwpx')
    const body = join(dir, 'book.html')
    await convert(fixture, 'epub', ebook)
    const epub = await openEpub(readFileSync(ebook))
    expect(epub.ok).toBe(true)
    if (!epub.ok) throw new Error(epub.detail)
    expect(epub.book.manifest.some((item) => item.mediaType.startsWith('image/'))).toBe(true)
    const zip = await JSZip.loadAsync(readFileSync(ebook))
    const opf = epub.book.opfPath
    const xml = await zip.file(opf)!.async('string')
    zip.file(
      opf,
      xml
        .replace(
          '</manifest>',
          '<item id="later" href="later.xhtml" media-type="application/xhtml+xml"/></manifest>',
        )
        .replace('</spine>', '<itemref idref="later"/></spine>'),
    )
    zip.file(
      'EPUB/later.xhtml',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>둘째 장</p></body></html>',
    )
    writeFileSync(ebook, await zip.generateAsync({ type: 'nodebuffer' }))
    await convert(ebook, 'hwpx', hwpx)
    await convert(hwpx, 'html', body)
    const html = readFileSync(body, 'utf8')
    expect(html).toContain('data:image/png;base64,')
    expect(html).toContain('<table')
    expect(html.indexOf('둘째 장')).toBeGreaterThan(html.indexOf('<table'))
  })

  it('keeps nested topics, sheet order and notes when a map passes through Hangul', async () => {
    const dir = tempDir()
    const original = join(dir, 'source.xmind')
    const result = join(dir, 'result.xmind')
    const hwpx = join(dir, 'map.hwpx')
    const outline =
      '# Sheet one\n- Busan\n  - Visit\n    - 바다\n      > A note\n# Sheet two\n- Paris\n  - Louvre'
    writeFileSync(
      original,
      await (await createXmindDocumentFromOutline(outline, { untitled: 'map' })).save(),
    )
    await convert(original, 'hwpx', hwpx)
    await convert(hwpx, 'xmind', result)
    const map = await openXmind(readFileSync(result))
    if (map.status !== 'ok') throw new Error(map.detail)
    expect(map.document.sheets).toHaveLength(2)
    const final = sheetsToOutline(map.document.sheets)
    expect(final).toContain('  - Visit\n    - 바다\n      > A note')
    expect(final).toContain('# Sheet two')
  })

  it('uses an explicit delimiter when a single TSV column contains commas', async () => {
    const dir = tempDir()
    const input = join(dir, 'source.tsv')
    const workbook = join(dir, 'cells.xlsx')
    writeFileSync(input, 'City, province, district\nBusan, Gangseo, Daejeo\n')
    await convert(input, 'xlsx', workbook)
    const zip = await JSZip.loadAsync(readFileSync(workbook))
    const xml = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(xml).toContain('Busan, Gangseo, Daejeo')
    expect(xml).not.toContain('r="B2"')
  })

  it.skipIf(!xlsxSidecarPath())(
    'keeps Hangul cell strings in separate columns when converted to Excel and back',
    async () => {
      const dir = tempDir()
      const fixture = join(__dirname, '../../../apps/hwp/tests/fixtures/nested-depth2.hwp')
      const workbook = join(dir, 'cells.xlsx')
      const hwpx = join(dir, 'cells.hwpx')
      const html = join(dir, 'round-trip.html')
      await convert(fixture, 'xlsx', workbook)
      await convert(workbook, 'hwpx', hwpx)
      await convert(hwpx, 'html', html)
      const doc = new DOMParser().parseFromString(readFileSync(html, 'utf8'), 'text/html')
      const rows = [...doc.querySelectorAll('tr')].map((row) =>
        [...row.cells].map((cell) => cell.textContent?.trim()),
      )
      expect(rows).toContainEqual(['0-2', '0-3'])
    },
  )
})
