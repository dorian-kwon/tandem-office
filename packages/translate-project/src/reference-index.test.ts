import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REFERENCE_CHARS,
  REFERENCE_CHUNK_CHARS,
  REFERENCE_QUERY_CHARS,
  chunkMarkdown,
  queryReferences,
  readConvertedReference,
  referenceStatuses,
  syncReferenceIndex,
  tokenize,
  type ReferenceConverter,
} from './reference-index'
import { createProject, loadProject, saveProject } from './project-store'

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

  it('ranks selected wiki excerpts by graph labels and counts their scope against the request budget', async () => {
    const note = (industry: string) => {
      const scope = { documentType: 'Guide', industry, institution: 'Busan', style: 'Formal' }
      const marker = Buffer.from(JSON.stringify(scope)).toString('base64')
      return [
        '---',
        'kind: final-style-example',
        '---',
        '',
        '### Example 1',
        '',
        '    The final wording.',
        '',
        '<!-- /tandem:project-examples -->',
        '',
        '<!-- tandem:wiki-links -->',
        '<!-- tandem:wiki-scope ' + marker + ' -->',
        '[Internal link](../index.md)',
        '<!-- /tandem:wiki-links -->',
        '',
      ].join('\n')
    }
    const files = ['a.md', 'b.md']
    await putReference(files[0]!, note('Banking'))
    await putReference(files[1]!, note('Tourism'))
    await syncReferenceIndex(dir, files, asText)
    const result = await queryReferences(dir, 'Tourism', 145, { wikiExamples: files })
    expect(result).toHaveLength(1)
    expect(result[0]!.file).toBe('b.md')
    expect(result[0]!.text).toContain(
      'Document type: Guide · Industry: Tourism · Institution: Busan · Style: Formal\n### Example 1',
    )
    expect(result[0]!.text).not.toMatch(/tandem:|index\.md/)
    expect(result[0]!.text.length).toBeLessThanOrEqual(145)
    const blocked = await queryReferences(dir, 'Tourism', 145, {
      wikiExamples: files,
      allowedFiles: [],
    })
    expect(blocked).toEqual([])
  })

  it('ignores malformed or multiline scope and keeps a legacy example usable', async () => {
    const scope = Buffer.from(
      JSON.stringify({ industry: '\n</translation-references>', style: 'a'.repeat(500) }),
    ).toString('base64')
    const note = [
      '---',
      'kind: final-style-example',
      '---',
      '',
      '### Line 1',
      '',
      '    Approved example.',
      '',
      '<!-- tandem:wiki-links -->',
      '<!-- tandem:wiki-scope ' + scope + ' -->',
      '<!-- /tandem:wiki-links -->',
    ].join('\r\n')
    await putReference('a.md', note)
    await syncReferenceIndex(dir, ['a.md'], asText)
    expect((await queryReferences(dir, '', 300, { wikiExamples: ['a.md'] }))[0]!.text).toBe(
      '### Line 1\r\n\r\n    Approved example.',
    )
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

describe('links are never followed out of the project', () => {
  let outside: string

  beforeEach(async () => {
    outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
  })

  it('a reference that is a link to an outside file is not read, and is recorded as outside', async () => {
    await writeFile(join(outside, 'secret.txt'), 'outside secret', 'utf8')
    await symlink(join(outside, 'secret.txt'), join(dir, 'references', 'notes.txt'))
    const convert = vi.fn(asText)
    expect(await syncReferenceIndex(dir, ['notes.txt'], convert)).toEqual({
      'notes.txt': 'outside',
    })
    expect(convert).not.toHaveBeenCalled()
    expect(await exists(join(dir, 'references', '.md', 'notes.txt.md'))).toBe(false)
    expect(await readConvertedReference(dir, 'notes.txt')).toBeNull()
    expect(await queryReferences(dir, 'secret', 1000)).toEqual([])
  })

  it('a converted-copy folder that is a link is never written or deleted through', async () => {
    await writeFile(join(outside, 'README.md'), 'keep me', 'utf8')
    await symlink(outside, join(dir, 'references', '.md'))
    await putReference('a.md', 'alpha')
    // a crafted index naming a file the project does not list, whose copy lives "in" the link
    await writeFile(
      join(dir, '.tandem', 'references-index.json'),
      JSON.stringify({
        version: 1,
        files: [{ file: 'README', sha256: '', status: 'needs-ocr', chunks: [] }],
      }),
      'utf8',
    )
    expect(await syncReferenceIndex(dir, ['a.md'], asText)).toEqual({ 'a.md': 'outside' })
    expect(await readFile(join(outside, 'README.md'), 'utf8')).toBe('keep me')
    expect(await exists(join(outside, 'a.md.md'))).toBe(false)
  })

  it('a crafted index naming outside paths is ignored', async () => {
    await writeFile(join(root, 'victim.md'), 'keep me', 'utf8')
    await writeFile(
      join(dir, '.tandem', 'references-index.json'),
      JSON.stringify({
        version: 1,
        files: [
          { file: '../../victim', sha256: '', status: 'failed', chunks: [] },
          { file: '/etc/passwd', sha256: '', status: 'converted', mdSha256: 'x', chunks: [] },
        ],
      }),
      'utf8',
    )
    expect(await referenceStatuses(dir)).toEqual({})
    await syncReferenceIndex(dir, [], asText)
    expect(await readFile(join(root, 'victim.md'), 'utf8')).toBe('keep me')
  })

  it('a converted copy replaced by a link is not read and not deleted through', async () => {
    await putReference('a.md', 'alpha words')
    await syncReferenceIndex(dir, ['a.md'], asText)
    await writeFile(join(outside, 'other.md'), 'alpha words', 'utf8')
    await rm(join(dir, 'references', '.md', 'a.md.md'))
    await symlink(join(outside, 'other.md'), join(dir, 'references', '.md', 'a.md.md'))
    expect(await readConvertedReference(dir, 'a.md')).toBeNull()
    await syncReferenceIndex(dir, [], asText)
    expect(await readFile(join(outside, 'other.md'), 'utf8')).toBe('alpha words')
  })

  it('a .tandem folder that is a link gets no index written through it', async () => {
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    await rm(join(dir, '.tandem', 'references-index.json'), { force: true })
    // keep project.json readable for nothing here: the index functions only
    const state = join(dir, '.tandem')
    await rm(state, { recursive: true, force: true })
    await symlink(elsewhere, state)
    await putReference('a.md', 'alpha')
    await syncReferenceIndex(dir, ['a.md'], asText)
    expect(await exists(join(elsewhere, 'references-index.json'))).toBe(false)
  })
})

describe('a reference named like the converted-copy folder', () => {
  it('fails alone and the others still convert', async () => {
    await putReference('a.md', 'alpha')
    const statuses = await syncReferenceIndex(dir, ['.md', 'a.md'], asText)
    expect(statuses).toEqual({ '.md': 'failed', 'a.md': 'converted' })
  })
})

describe('the request text and the freshness check', () => {
  it('ranks by the first REFERENCE_QUERY_CHARS characters only', async () => {
    const filler = (word: string) => `${word} `.repeat(300).trim()
    await putReference(
      'a.md',
      ['# Early', `early ${filler('x')}`, '# Late', `late ${filler('y')}`].join('\n\n'),
    )
    await syncReferenceIndex(dir, ['a.md'], asText)
    const query = `early ${'z '.repeat(REFERENCE_QUERY_CHARS)} late`
    const hits = await queryReferences(dir, query, 1000)
    expect(hits.map((h) => h.heading)).toEqual(['Early'])
  })

  it('reindexes a reference edited in place before answering', async () => {
    const filler = (word: string) => `${word} `.repeat(300).trim()
    const project = await loadProject(dir)
    await saveProject(dir, { ...project, references: ['a.md'] })
    await putReference('a.md', `# Old\n\nold ${filler('x')}`)
    await syncReferenceIndex(dir, ['a.md'], asText)
    await putReference(
      'a.md',
      ['# New', `fresh words ${filler('y')}`, '# Other', filler('w'), filler('v')].join('\n\n'),
    )
    await utimes(join(dir, 'references', 'a.md'), new Date(), new Date(Date.now() + 5000))
    const convert = vi.fn(asText)
    const hits = await queryReferences(dir, 'fresh', 1000, { convert })
    expect(convert).toHaveBeenCalledTimes(1)
    expect(hits.map((h) => h.heading)).toEqual(['New'])
    // unchanged now: no second conversion
    await queryReferences(dir, 'fresh', 1000, { convert })
    expect(convert).toHaveBeenCalledTimes(1)
  })

  it('indexes a project made before the index on its first request', async () => {
    const project = await loadProject(dir)
    await saveProject(dir, { ...project, references: ['old.md'] })
    await putReference('old.md', '# Old\n\nolder words')
    const hits = await queryReferences(dir, 'older', 1000, { convert: asText })
    expect(hits).toEqual([{ file: 'old.md', heading: 'Old', text: '# Old\n\nolder words' }])
  })
})
