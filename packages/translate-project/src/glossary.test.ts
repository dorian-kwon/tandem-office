import { readFileSync } from 'node:fs'
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
