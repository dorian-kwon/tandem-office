import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FINAL_NOTES_FOLDER, ingestFinalNote } from '../src/main/translate/wiki-final-notes'
import { prepareTranslationVault } from '../src/main/translate/wiki-vault'

describe('finished document learning', () => {
  let profile: string
  let vault: string
  let folder: string

  beforeEach(async () => {
    profile = await mkdtemp(join(tmpdir(), 'wiki-final-'))
    vault = join(profile, 'translation-wiki', 'vault')
    folder = join(vault, FINAL_NOTES_FOLDER)
  })
  afterEach(async () => {
    await rm(profile, { recursive: true, force: true })
  })

  it('publishes bounded samples with source lines and keeps original notes and markup literal', async () => {
    const { indexPath } = await prepareTranslationVault(profile, 'ko')
    await writeFile(indexPath, '# 내 목차\n')
    await writeFile(join(vault, 'style.md'), '내 문체 메모')
    const body = Array.from({ length: 100 }, (_, i) => {
      if (i === 0) return '![링크](https://example.com/image.png)'
      return '한국어 본문 ' + (i + 1) + ' 가나다'.repeat(100)
    }).join('\r\n')
    expect(await ingestFinalNote(profile, 'ko', 'C:\\private\\[[안내서]].txt', body)).toBe('added')
    const [note] = await readdir(folder)
    const content = await readFile(join(folder, note!), 'utf8')
    expect(content).toContain('source: "[[안내서]].txt"')
    expect(content).not.toContain('private')
    expect(content).toContain('### 추출 본문 행 1\n\n    ![링크](')
    expect(content).toContain('### 추출 본문 행 100\n\n    한국어 본문 100')
    expect(content.match(/^### /gm)).toHaveLength(8)
    expect(content.length).toBeLessThan(3200)
    expect(content).toContain('[문체](../style.md)')
    expect(await readFile(join(vault, 'style.md'), 'utf8')).toBe('내 문체 메모')
    expect(await readFile(indexPath, 'utf8')).toBe(
      '# 내 목차\n\n- [문체](style.md)\n- [완성본](final-documents.md)\n',
    )
    expect(await readFile(join(vault, 'final-documents.md'), 'utf8')).toContain(
      '[번역 위키](index.md)',
    )
  })

  it('imports concurrent copies once, preserves edited examples, and distinguishes a revised file', async () => {
    const ingest = (revision: string) =>
      ingestFinalNote(profile, 'en', 'brief.pdf', 'Final copy.', revision)
    const results = await Promise.all(Array.from({ length: 8 }, () => ingest('file hash v1')))
    expect(results.sort()).toEqual(['added', ...Array(7).fill('duplicate')])
    expect(await readdir(folder)).toHaveLength(1)
    const [note] = await readdir(folder)
    const saved = join(folder, note!)
    await writeFile(saved, 'Edited in Obsidian')
    expect(await ingest('file hash v1')).toBe('duplicate')
    expect(await ingest('file hash v2')).toBe('added')
    expect(await readdir(folder)).toHaveLength(2)
    expect(await readFile(saved, 'utf8')).toBe('Edited in Obsidian')
    const index = await readFile(join(vault, 'index.md'), 'utf8')
    expect(index.match(/\]\(final-documents.md\)/g)).toHaveLength(1)
  })

  it('updates the same project deliverable in place while preserving manual properties and surrounding text', async () => {
    const project = join(profile, 'client')
    const learn = (name: string, body: string) =>
      ingestFinalNote(profile, 'en', name, body, undefined, project, 'guide.en.pdf')
    expect(await learn('guide.en.pdf', 'Old copy')).toBe('added')
    const [note] = await readdir(folder)
    const path = join(folder, note!)
    const first = await readFile(path, 'utf8')
    const custom =
      first
        .replace('institution: null', 'institution: Busan\ncustom: true')
        .replace('<!-- tandem:', 'My introduction.\n<!-- tandem:') + 'My conclusion.\n'
    await writeFile(path, custom.replaceAll('\n', '\r\n'))
    expect(await learn('guide.en (2).pdf', 'Revised copy')).toBe('updated')
    const revised = await readFile(path, 'utf8')
    expect(revised).toContain('source: "guide.en (2).pdf"')
    expect(revised).toContain('institution: Busan\r\ncustom: true')
    expect(revised).toContain('My introduction.\r\n')
    expect(revised).toContain('My conclusion.\r\n')
    expect(revised).toContain('    Revised copy\r\n')
    expect(revised).not.toContain('Old copy')
    expect(revised.match(/^revision: (.+)$/m)?.[1]).not.toEqual(
      first.match(/^revision: (.+)$/m)?.[1],
    )
    const edited = revised.replace('    Revised copy', '    My edit')
    await writeFile(path, edited)
    expect(await learn('guide.en (2).pdf', 'Revised copy')).toBe('duplicate')
    expect(await readFile(path, 'utf8')).toBe(edited)
    expect(await learn('guide.en (3).pdf', 'Revised copy')).toBe('duplicate')
    const renumbered = await readFile(path, 'utf8')
    expect(renumbered).toContain('source: "guide.en (3).pdf"')
    expect(renumbered).toContain('    My edit\r\n')
    expect(await readdir(folder)).toEqual([note])
  })

  it('separates identically named results from other projects and older home imports', async () => {
    for (const dir of [undefined, join(profile, 'A'), join(profile, 'B')]) {
      expect(await ingestFinalNote(profile, 'ko', '결과.docx', '공통 문장', undefined, dir)).toBe(
        'added',
      )
    }
    expect(
      await ingestFinalNote(profile, 'ko', '결과.docx', '갱신 문장', undefined, join(profile, 'A')),
    ).toBe('updated')
    const notes = await Promise.all(
      (await readdir(folder)).map((name) => readFile(join(folder, name), 'utf8')),
    )
    expect(notes.filter((text) => text.includes('공통 문장'))).toHaveLength(2)
    expect(notes.filter((text) => text.includes('갱신 문장'))).toHaveLength(1)
  })

  it('protects a replaced project note whose generated block is no longer identifiable', async () => {
    const project = join(profile, 'client')
    await ingestFinalNote(profile, 'ko', 'report.docx', '완성 문장', undefined, project)
    const [note] = await readdir(folder)
    const path = join(folder, note!)
    await writeFile(path, '# Completely rewritten')
    await expect(
      ingestFinalNote(profile, 'ko', 'report.docx', '새 문장', undefined, project),
    ).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('# Completely rewritten')
  })

  it.each([
    [
      'deck.pptx',
      '[No extractable text: none of the slides carries text]\n## Slide 1\n[picture-only slide: 1 image, no extractable text]\n### Notes\nSpeaker notes',
    ],
    ['sheet.xlsx', '# Sheet1\n[image-only sheet: a drawing but no cell data]'],
    ['report.hwpx', '### Comments\n작성자 메모'],
    ['blank.hwp', '123\n| |\n\t'],
    ['draft.docx', '[image-only document: 1 image, no extractable text]\n## Comments\nA comment'],
  ])('skips annotations, placeholders and empty extracts in %s', async (name, text) => {
    expect(await ingestFinalNote(profile, 'ko', name, text)).toBe('empty')
    expect(await readdir(profile)).toEqual([])
  })

  it('keeps text from slides after reviewer-only sections', async () => {
    const text = '## Slide 1\nFirst slide\n### Comments\nPrivate review\n## Slide 2\nSecond slide'
    await ingestFinalNote(profile, 'en', 'deck.pptx', text)
    const [note] = await readdir(folder)
    const content = await readFile(join(folder, note!), 'utf8')
    expect(content).not.toContain('Private review')
    expect(content).toContain('### Extracted text line 6\n\n    Second slide')
  })

  it('refuses to write through a linked notes directory', async () => {
    await prepareTranslationVault(profile, 'ko')
    const outside = join(profile, 'outside')
    await mkdir(outside)
    await symlink(outside, folder, 'junction')
    await expect(ingestFinalNote(profile, 'ko', 'guide.txt', '완성 문구')).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })
})
