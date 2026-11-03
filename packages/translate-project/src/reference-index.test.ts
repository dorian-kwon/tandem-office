import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REFERENCE_CHARS,
  REFERENCE_CHUNK_CHARS,
  chunkMarkdown,
  queryReferences,
  readConvertedReference,
  referenceStatuses,
  syncReferenceIndex,
  tokenize,
  type ReferenceConverter,
} from './reference-index'
import { createProject } from './project-store'

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refindex-'))
  dir = (await createProject(root, 'proj', 'ko', 'en')).dir
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null

/** a converter that reads the reference file as markdown text */
const asText: ReferenceConverter = async (path) => ({ ok: true, md: await readFile(path, 'utf8') })

async function putReference(name: string, body: string): Promise<void> {
  await writeFile(join(dir, 'references', name), body, 'utf8')
}

describe('tokenize', () => {
  it('splits other scripts into lower-case words', () => {
    expect(tokenize('Hello, World! v2.0 naïve')).toEqual(['hello', 'world', 'v2', '0', 'naïve'])
  })

  it('splits Korean, Chinese and Japanese runs into character bigrams', () => {
    expect(tokenize('계약서 검토')).toEqual(['계약', '약서', '검토'])
    expect(tokenize('合同')).toEqual(['合同'])
    expect(tokenize('字')).toEqual(['字'])
    expect(tokenize('ABC계약')).toEqual(['abc', '계약'])
  })
})

describe('chunkMarkdown', () => {
  it('starts a chunk at every heading and labels it with that heading', () => {
    const md = 'intro text\n\n# First\n\npara one\n\npara two\n\n## Second\n\npara three\n'
    const chunks = chunkMarkdown(md)
    expect(chunks.map((c) => c.heading)).toEqual(['', 'First', 'Second'])
    expect(chunks.map((c) => md.slice(c.offset, c.offset + c.length))).toEqual([
      'intro text',
      '# First\n\npara one\n\npara two',
      '## Second\n\npara three',
    ])
  })

  it('groups paragraphs up to the chunk size and splits a longer paragraph', () => {
    const para = 'word '.repeat(100).trim() // 499 characters
    const md = [para, para, para, 'x'.repeat(REFERENCE_CHUNK_CHARS * 2 + 10)].join('\n\n')
    const chunks = chunkMarkdown(md)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(REFERENCE_CHUNK_CHARS)
    // two paragraphs fit in one chunk, the third starts the next one
    expect(md.slice(chunks[0]!.offset, chunks[0]!.offset + chunks[0]!.length)).toBe(
      `${para}\n\n${para}`,
    )
    const rebuilt = chunks.map((c) => md.slice(c.offset, c.offset + c.length)).join('')
    expect(rebuilt.replace(/\s/g, '')).toBe(md.replace(/\s/g, ''))
  })

  it('returns nothing for blank text', () => {
    expect(chunkMarkdown('  \n\n ')).toEqual([])
  })
})

describe('syncReferenceIndex', () => {
  it('writes the converted copy and the index, and reports each file', async () => {
    await putReference('a.md', '# Alpha\n\nalpha text')
    const statuses = await syncReferenceIndex(dir, ['a.md'], asText)
    expect(statuses).toEqual({ 'a.md': 'converted' })
    expect(await readFile(join(dir, 'references', '.md', 'a.md.md'), 'utf8')).toBe(
      '# Alpha\n\nalpha text',
    )
    const index = JSON.parse(await readFile(join(dir, '.tandem', 'references-index.json'), 'utf8'))
    expect(index.version).toBe(1)
    expect(index.files[0]).toMatchObject({ file: 'a.md', status: 'converted' })
    expect(index.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(index.files[0].chunks[0]).toMatchObject({ heading: 'Alpha', offset: 0 })
    expect(index.files[0].chunks[0].terms.alpha).toBe(2)
    expect(await referenceStatuses(dir)).toEqual({ 'a.md': 'converted' })
    expect(await readConvertedReference(dir, 'a.md')).toBe('# Alpha\n\nalpha text')
  })

  it('never modifies the reference file itself', async () => {
    await putReference('a.md', 'keep me')
    await syncReferenceIndex(dir, ['a.md'], asText)
    expect(await readFile(join(dir, 'references', 'a.md'), 'utf8')).toBe('keep me')
  })

  it('does not convert again while the source is unchanged, and rebuilds when its sha changes', async () => {
    await putReference('a.md', 'first version')
    const convert = vi.fn(asText)
    await syncReferenceIndex(dir, ['a.md'], convert)
    await syncReferenceIndex(dir, ['a.md'], convert)
    expect(convert).toHaveBeenCalledTimes(1)
    await putReference('a.md', 'second version')
    await syncReferenceIndex(dir, ['a.md'], convert)
    expect(convert).toHaveBeenCalledTimes(2)
    expect(await readConvertedReference(dir, 'a.md')).toBe('second version')
  })

  it('rebuilds when the converted copy was changed or removed by hand', async () => {
    await putReference('a.md', 'original words')
    const convert = vi.fn(asText)
    await syncReferenceIndex(dir, ['a.md'], convert)
    await writeFile(join(dir, 'references', '.md', 'a.md.md'), 'edited', 'utf8')
    await syncReferenceIndex(dir, ['a.md'], convert)
    expect(convert).toHaveBeenCalledTimes(2)
    expect(await readConvertedReference(dir, 'a.md')).toBe('original words')
  })

  it('records a failure per file and keeps the others', async () => {
    await putReference('a.md', 'good words')
    await putReference('scan.png', 'binary')
    await putReference('bad.docx', 'x')
    const convert: ReferenceConverter = async (path) => {
      if (path.endsWith('.png')) return { ok: false, reason: 'needs-ocr' }
      if (path.endsWith('.docx')) throw new Error('boom')
      return asText(path)
    }
    const statuses = await syncReferenceIndex(
      dir,
      ['a.md', 'scan.png', 'bad.docx', 'gone.txt'],
      convert,
    )
    expect(statuses).toEqual({
      'a.md': 'converted',
      'scan.png': 'needs-ocr',
      'bad.docx': 'failed',
      'gone.txt': 'failed',
    })
    expect(await exists(join(dir, 'references', '.md', 'scan.png.md'))).toBe(false)
  })

  it('drops files no longer listed, with their converted copy', async () => {
    await putReference('a.md', 'alpha')
    await putReference('b.md', 'beta')
    await syncReferenceIndex(dir, ['a.md', 'b.md'], asText)
    await syncReferenceIndex(dir, ['b.md'], asText)
    expect(await referenceStatuses(dir)).toEqual({ 'b.md': 'converted' })
    expect(await exists(join(dir, 'references', '.md', 'a.md.md'))).toBe(false)
  })

  it('reads a damaged index as empty', async () => {
    await writeFile(join(dir, '.tandem', 'references-index.json'), '{not json', 'utf8')
    expect(await referenceStatuses(dir)).toEqual({})
    expect(await queryReferences(dir, 'anything', 100)).toEqual([])
    await putReference('a.md', 'alpha')
    expect(await syncReferenceIndex(dir, ['a.md'], asText)).toEqual({ 'a.md': 'converted' })
  })
})

describe('queryReferences', () => {
  const filler = (word: string) => `${`${word} `.repeat(150).trim()}` // 600 to 900 characters

  async function corpus(): Promise<void> {
    await putReference(
      'law.md',
      [
        '# Contract',
        `contract liability clause ${filler('law')}`,
        '# Weather',
        filler('rain'),
      ].join('\n\n'),
    )
    await putReference(
      'guide.md',
      [
        '# Style',
        `contract ${filler('style')}`,
        '# Liability',
        `liability liability ${filler('note')}`,
      ].join('\n\n'),
    )
    await syncReferenceIndex(dir, ['law.md', 'guide.md'], asText)
  }

  it('orders chunks by BM25 score for the request text', async () => {
    await corpus()
    const hits = await queryReferences(dir, 'the liability clause of the contract', 2500)
    expect(hits.map((h) => `${h.file}:${h.heading}`)).toEqual([
      'law.md:Contract',
      'guide.md:Liability',
      'guide.md:Style',
    ])
    expect(hits[0]!.text.startsWith('# Contract')).toBe(true)
  })

  it('never goes over the character cap', async () => {
    await corpus()
    const hits = await queryReferences(dir, 'liability contract clause', 2100)
    const total = hits.reduce((n, h) => n + h.text.length, 0)
    expect(total).toBeLessThanOrEqual(2100)
    expect(hits.length).toBe(2)
    expect(await queryReferences(dir, 'liability', 10)).toEqual([])
  })

  it('returns nothing when no word of the request appears', async () => {
    await corpus()
    expect(await queryReferences(dir, 'zebra', 2500)).toEqual([])
    expect(await queryReferences(dir, '', 2500)).toEqual([])
  })

  it('passes a small corpus through whole, without ranking', async () => {
    await putReference('a.md', '# One\n\nfirst')
    await putReference('b.md', '# Two\n\nsecond')
    await syncReferenceIndex(dir, ['a.md', 'b.md'], asText)
    const hits = await queryReferences(dir, 'nothing matches', DEFAULT_REFERENCE_CHARS)
    expect(hits).toEqual([
      { file: 'a.md', heading: 'One', text: '# One\n\nfirst' },
      { file: 'b.md', heading: 'Two', text: '# Two\n\nsecond' },
    ])
    // exactly at the cap still passes through
    const total = '# One\n\nfirst'.length + '# Two\n\nsecond'.length
    expect(await queryReferences(dir, '', total)).toHaveLength(2)
    expect(await queryReferences(dir, '', total - 1)).toEqual([])
  })

  it('ranks Korean text by character bigrams', async () => {
    await putReference(
      'ko.md',
      [
        '# 계약',
        `계약서의 손해배상 조항 ${filler('가')}`,
        '# 날씨',
        `오늘 날씨 ${filler('나')}`,
      ].join('\n\n'),
    )
    await syncReferenceIndex(dir, ['ko.md'], asText)
    const hits = await queryReferences(dir, '손해배상 책임', 400)
    expect(hits.map((h) => h.heading)).toEqual(['계약'])
  })

  it('skips a converted copy that no longer matches the index', async () => {
    await putReference('a.md', '# One\n\nfirst')
    await syncReferenceIndex(dir, ['a.md'], asText)
    await writeFile(join(dir, 'references', '.md', 'a.md.md'), 'changed', 'utf8')
    expect(await queryReferences(dir, 'first', 1000)).toEqual([])
  })
})
