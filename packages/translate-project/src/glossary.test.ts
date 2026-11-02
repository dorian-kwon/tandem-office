import { readFileSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseGlossary, selectGlossary, type GlossaryEntry } from './glossary'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)))

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

const many = (count: number): GlossaryEntry[] =>
  Array.from({ length: count }, (_, i) => ({ source: `용어${i}번`, target: `term${i}` }))

describe('parseGlossary', () => {
  it('parses cp949 csv without mojibake', () => {
    const entries = parseGlossary(fixture('glossary-cp949.csv'), 'glossary-cp949.csv')
    expect(entries[0]).toEqual({ source: '계약', target: 'contract', note: '법률 용어' })
    expect(entries[1]).toEqual({ source: '당사자', target: 'party' })
  })

  it('parses a minimal cp949 pair', () => {
    // "계약,contract" in CP949
    const bytes = new Uint8Array([0xb0, 0xe8, 0xbe, 0xe0, 0x2c, ...enc('contract')])
    expect(parseGlossary(bytes, 'a.csv')).toEqual([{ source: '계약', target: 'contract' }])
  })

  it('skips header row', () => {
    const entries = parseGlossary(fixture('glossary-header.csv'), 'glossary-header.csv')
    expect(entries).toEqual([
      { source: '계약', target: 'contract', note: '법률 용어' },
      { source: '당사자', target: 'party' },
    ])
  })

  it('parses tab separated txt', () => {
    const entries = parseGlossary(fixture('glossary.txt'), 'glossary.txt')
    expect(entries).toEqual([
      { source: '계약', target: 'contract', note: '법률 용어' },
      { source: '당사자', target: 'party' },
    ])
  })

  it('reads only the first xlsx sheet', () => {
    const entries = parseGlossary(fixture('glossary.xlsx'), 'glossary.xlsx')
    expect(entries).toEqual([
      { source: '계약', target: 'contract', note: '법률 용어' },
      { source: '당사자', target: 'party' },
    ])
  })

  it('ignores blank lines and rows with empty source', () => {
    const entries = parseGlossary(enc('a,b\n\n,orphan\n  ,x\nc,d\r\n'), 'g.csv')
    expect(entries).toEqual([
      { source: 'a', target: 'b' },
      { source: 'c', target: 'd' },
    ])
  })

  it('handles quoted csv fields and a utf-8 bom', () => {
    const entries = parseGlossary(enc('﻿"a,1","say ""hi"""\n'), 'g.csv')
    expect(entries).toEqual([{ source: 'a,1', target: 'say "hi"' }])
  })

  it('rejects unsupported extensions', () => {
    expect(() => parseGlossary(enc('a,b'), 'g.docx')).toThrow()
  })
})

describe('selectGlossary', () => {
  it('returns all entries at or below limit', () => {
    const entries = many(200)
    expect(selectGlossary(entries, 'unrelated')).toEqual(entries)
  })

  it('returns only matching entries above limit', () => {
    const entries = many(201)
    const picked = selectGlossary(entries, '본문에 용어3번 과 용어150번 이 나온다')
    expect(picked.map((e) => e.source)).toEqual(['용어3번', '용어150번'])
  })

  it('honors a custom limit', () => {
    expect(selectGlossary(many(5), 'none', 4)).toEqual([])
    expect(selectGlossary(many(5), 'none', 5)).toHaveLength(5)
  })

  it('matches latin terms case-insensitively', () => {
    const entries = [...many(200), { source: 'Contract', target: '계약' }]
    expect(selectGlossary(entries, 'the CONTRACT is void')).toEqual([
      { source: 'Contract', target: '계약' },
    ])
  })
})

describe('header detection', () => {
  it('skips Source,Target,Note', () => {
    expect(parseGlossary(enc('Source,Target,Note\na,b\n'), 'g.csv')).toEqual([
      { source: 'a', target: 'b' },
    ])
  })

  it('skips 용어,번역', () => {
    expect(parseGlossary(enc('용어,번역\n계약,contract\n'), 'g.csv')).toEqual([
      { source: '계약', target: 'contract' },
    ])
  })

  it('keeps a real first entry', () => {
    expect(parseGlossary(enc('contract,계약\n'), 'g.csv')).toEqual([
      { source: 'contract', target: '계약' },
    ])
  })
})

// Minimal zip writer for test fixtures: one local header + central entry per part.
function zip(parts: { name: string; text: string; stored?: boolean }[]): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const part of parts) {
    const raw = Buffer.from(part.text, 'utf-8')
    const data = part.stored ? raw : deflateRawSync(raw)
    const name = Buffer.from(part.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(part.stored ? 0 : 8, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(part.stored ? 0 : 8, 10)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    chunks.push(local, name, data)
    central.push(entry, name)
    offset += 30 + name.length + data.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, dir, end]))
}

function xlsx(sheetData: string, shared: string, stored = false): Uint8Array {
  return zip([
    {
      name: 'xl/workbook.xml',
      text: '<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId9"/></sheets></workbook>',
      stored,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: '<Relationships><Relationship Id="rId9" Target="worksheets/data.xml"/></Relationships>',
      stored,
    },
    { name: 'xl/sharedStrings.xml', text: `<sst>${shared}</sst>`, stored },
    {
      name: 'xl/worksheets/data.xml',
      text: `<worksheet><sheetData>${sheetData}</sheetData></worksheet>`,
      stored,
    },
  ])
}

describe('xlsx edge cases', () => {
  const shared =
    '<si><t>계약</t></si><si><r><t>con</t></r><r><t xml:space="preserve">tract </t></r></si><si><t>비고</t></si>'

  it('reads shared strings, rich-text runs and column gaps', () => {
    const rows =
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c></row>'
    expect(parseGlossary(xlsx(rows, shared), 'g.xlsx')).toEqual([
      { source: '계약', target: '', note: '비고' },
      { source: '계약', target: 'contract' },
    ])
  })

  it('reads inlineStr and numeric cells, with a gap before column C', () => {
    const rows =
      '<row r="1"><c r="A1" t="inlineStr"><is><t>a &amp; b</t></is></c><c r="C1"><v>42</v></c></row>'
    expect(parseGlossary(xlsx(rows, ''), 'g.xlsx')).toEqual([
      { source: 'a & b', target: '', note: '42' },
    ])
  })

  it('reads stored (uncompressed) and deflated entries', () => {
    const rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>'
    const expected = [{ source: '계약', target: '비고' }]
    expect(parseGlossary(xlsx(rows, shared, true), 'g.xlsx')).toEqual(expected)
    expect(parseGlossary(xlsx(rows, shared, false), 'g.xlsx')).toEqual(expected)
  })

  it('throws on an out-of-range shared string index', () => {
    const rows = '<row r="1"><c r="A1" t="s"><v>99</v></c></row>'
    expect(() => parseGlossary(xlsx(rows, shared), 'g.xlsx')).toThrow(/out of range/)
  })
})
