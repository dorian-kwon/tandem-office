import { join } from 'node:path'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openEpub } from '@genoffice/epub-engine/core'
import {
  createXmindDocumentFromSheets,
  newSheet,
  newTopic,
  openXmind,
  sheetsToOutline,
} from '@genoffice/xmind-engine'
import {
  CONVERSION_ROUTES,
  DIRECT_CONVERSION_ROUTES,
  conversionPath,
} from '../src/conversion-routes'
import { run, tempDir } from './helpers'

const formats = [
  'docx',
  'odt',
  'hwp',
  'hwpx',
  'pdf',
  'html',
  'md',
  'txt',
  'pptx',
  'xlsx',
  'epub',
  'xmind',
  'csv',
  'tsv',
  'ods',
]

describe('editable document conversion routes', () => {
  it('connects every pair using direct registered edges without format cycles or equivalent outputs', () => {
    for (const from of [...formats, 'xls', 'xlsm', 'xlsb', 'htm', 'markdown']) {
      for (const to of formats) {
        const path = conversionPath(from, to)
        if (
          from === to ||
          (from === 'htm' && to === 'html') ||
          (from === 'markdown' && to === 'md')
        ) {
          expect(path).toBeNull()
          continue
        }
        expect(CONVERSION_ROUTES[from], from + '→' + to).toContain(to)
        expect(path?.at(0)).toBe(from)
        expect(path?.at(-1)).toBe(to)
        expect(new Set(path).size).toBe(path!.length)
        for (let i = 1; i < path!.length; i++)
          expect(DIRECT_CONVERSION_ROUTES[path![i - 1]!]).toContain(path![i])
        if (DIRECT_CONVERSION_ROUTES[from]!.includes(to)) expect(path).toHaveLength(2)
      }
    }
    expect(conversionPath('docx', 'epub')).toEqual(['docx', 'html', 'epub'])
    expect(conversionPath('odt', 'pptx')).toEqual(['odt', 'pdf', 'pptx'])
    expect(conversionPath('xlsx', 'xmind')).toEqual(['xlsx', 'html', 'xmind'])
    expect(conversionPath('csv', 'epub')).toEqual(['csv', 'xlsx', 'html', 'epub'])
    expect(conversionPath('docx', 'json')).toBeNull()
    expect(CONVERSION_ROUTES.json).toEqual(['txt'])
  })

  it('imports a Markdown book with a linked picture into a valid EPUB, then converts chapter text into a real map', async () => {
    const dir = tempDir()
    const input = join(dir, 'Busan.md')
    writeFileSync(input, '# 부산 여행\n\nVisit the sea.\n\n![coast](coast.png)')
    writeFileSync(
      join(dir, 'coast.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FOgAAAAASUVORK5CYII=',
        'base64',
      ),
    )
    const epub = join(dir, 'Busan.epub')
    const map = join(dir, 'Busan.xmind')
    const book = await run(['convert', input, '--to', 'epub', '--out', epub, '--json'])
    expect(book.code, book.stdout).toBe(0)
    const openedBook = await openEpub(readFileSync(epub))
    if (!openedBook.ok) throw Error(openedBook.detail)
    expect(openedBook.book.manifest.some((item) => item.mediaType === 'image/png')).toBe(true)
    expect(openedBook.book.metadata.title).toBe('Busan')
    const result = await run(['convert', epub, '--to', 'xmind', '--out', map, '--json'])
    expect(result.code, result.stdout).toBe(0)
    const opened = await openXmind(readFileSync(map))
    if (opened.status !== 'ok') throw Error(opened.detail)
    expect(sheetsToOutline(opened.document.sheets)).toContain('Visit the sea.')
    expect(readdirSync(dir).some((name) => name.startsWith('.ieumoffice-convert-'))).toBe(false)
  })

  it('keeps a packaged XMind picture beside its topic in the editable HTML bridge', async () => {
    const dir = tempDir()
    const sheet = newSheet({ title: 'Field notes', rootTitle: 'Review' })
    const pictured = newTopic('Scanned register')
    pictured.image = { src: 'xap:resources/scan.png' }
    sheet.rootTopic.children = { attached: [pictured, newTopic('Next topic')] }
    const doc = await createXmindDocumentFromSheets([sheet])
    const png = readFileSync(
      new URL('../../pdf2docx/ocr-helper/fixtures/smoke-en.png', import.meta.url),
    )
    doc.addEntry('resources/scan.png', png)
    const input = join(dir, 'notes.xmind')
    const output = join(dir, 'notes.html')
    writeFileSync(input, await doc.save())
    const result = await run(['convert', input, '--to', 'html', '--out', output, '--json'])
    expect(result.code, result.stdout).toBe(0)
    const html = readFileSync(output, 'utf8')
    expect(html).toContain('data:image/png;base64,' + png.toString('base64'))
    expect(html.indexOf('Scanned register')).toBeLessThan(html.indexOf('<img'))
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('Next topic'))
  })

  it('keeps leading zeros, delimiters and line breaks through CSV and TSV', async () => {
    const dir = tempDir(),
      csv = join(dir, 'input.csv'),
      tsv = join(dir, 'input.tsv'),
      back = join(dir, 'result.csv')
    const value = 'ID,Name\r\n00123,"Busan, city"\r\n00124,"two\nlines"\r\n'
    writeFileSync(csv, value)
    for (const [input, target, out] of [
      [csv, 'tsv', tsv],
      [tsv, 'csv', back],
    ] as const) {
      expect((await run(['convert', input, '--to', target, '--out', out, '--json'])).code).toBe(0)
    }
    expect(readFileSync(back, 'utf8')).toBe('\ufeff' + value)
  })

  it('validates JSON without mapping ordinary documents onto a new schema', async () => {
    const dir = tempDir(),
      text = join(dir, 'fields.txt'),
      json = join(dir, 'fields.json')
    writeFileSync(text, '{"기관":"부산", "number": 900719925474099312345}\n')
    expect((await run(['convert', text, '--to', 'json', '--out', json, '--json'])).code).toBe(0)
    expect(readFileSync(json)).toEqual(readFileSync(text))
    writeFileSync(text, 'not JSON')
    expect(
      (await run(['convert', text, '--to', 'json', '--out', json, '--force', '--json'])).code,
    ).not.toBe(0)
    expect(JSON.parse(readFileSync(json, 'utf8')).기관).toBe('부산')
  })
})
