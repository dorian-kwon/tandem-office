import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ingestFinalNote } from '../src/main/translate/wiki-final-notes'
import { migrateWikiGraph } from '../src/main/translate/wiki-graph-migrate'
import { prepareTranslationVault } from '../src/main/translate/wiki-vault'

let profile: string
afterEach(async () => {
  if (profile) await rm(profile, { recursive: true, force: true })
})

it('navigates from the index through a type to related documents and back and honors reclassification', async () => {
  profile = await mkdtemp(join(tmpdir(), 'wiki-graph-'))
  const { vaultPath, indexPath } = await prepareTranslationVault(profile, 'ko')
  const lines = Array.from({ length: 70 }, (_, i) =>
    i === 1 ? '발행처: 부산관광공사' : '여행 본문 ' + i,
  )
  await ingestFinalNote(profile, 'ko', '부산 관광 안내서.txt', lines.join('\n'))
  await ingestFinalNote(profile, 'ko', '해운대 안내서.txt', '방문객을 위한 해운대 안내서.')
  await migrateWikiGraph(vaultPath, 'ko')
  const read = (path: string) => readFile(path, 'utf8')
  const linkTo = async (path: string, title: string) => {
    const href = (await read(path)).split('[' + title + '](')[1]?.split(')')[0]
    expect(href, title + ' in ' + path).toBeTruthy()
    return resolve(dirname(path), decodeURIComponent(href!))
  }
  const types = await linkTo(indexPath, '문서 종류')
  const guides = await linkTo(types, '안내서')
  expect(basename(guides)).toBe('안내서.md')
  const busan = await linkTo(guides, '부산 관광 안내서.txt')
  expect(await linkTo(busan, '안내서')).toBe(guides)
  expect(await linkTo(busan, '번역 위키')).toBe(indexPath)
  expect(await linkTo(await linkTo(busan, '부산관광공사'), '부산 관광 안내서.txt')).toBe(busan)
  const other = await linkTo(guides, '해운대 안내서.txt')
  expect(await linkTo(await linkTo(indexPath, '완성본'), '해운대 안내서.txt')).toBe(other)
  await writeFile(
    busan,
    (await read(busan)).replace('document_type: null', 'document_type: 내 분류') + '내 메모\n',
  )
  await unlink(other)
  await migrateWikiGraph(vaultPath, 'ko')
  const custom = await linkTo(types, '내 분류')
  expect(await linkTo(custom, '부산 관광 안내서.txt')).toBe(busan)
  expect(await read(busan)).toContain('내 메모')
  expect(await read(guides)).not.toContain('안내서.txt')
  expect(await read(types)).not.toContain('[안내서](')
  await unlink(custom)
  await migrateWikiGraph(vaultPath, 'ko')
  expect(await readdir(join(vaultPath, 'categories'))).toContain(custom.split('/').pop())
})

it('groups explicit localized categories with inferred equivalents and exposes their scope for translation', async () => {
  profile = await mkdtemp(join(tmpdir(), 'wiki-category-scope-'))
  const { vaultPath } = await prepareTranslationVault(profile, 'ko')
  await ingestFinalNote(profile, 'ko', 'A 여행 안내서.txt', '본문입니다.')
  await ingestFinalNote(profile, 'ko', 'B 자료.txt', '산업군: 조선·해양\n문서 종류: 안전 점검표')
  const folder = join(vaultPath, 'final-documents')
  const second = join(
    folder,
    (await readdir(folder)).find((n) => n.startsWith('B'))!,
  )
  const oldMarker = Buffer.from(
    JSON.stringify({ documentType: 'unclassified', industry: null }),
  ).toString('base64')
  await writeFile(
    second,
    (await readFile(second, 'utf8'))
      .replace('industry: null', 'industry: 관광')
      .replace(
        /tandem:wiki-classification [A-Za-z0-9+/=]+/,
        'tandem:wiki-classification ' + oldMarker,
      ),
  )
  await migrateWikiGraph(vaultPath, 'ko')
  const tourism = join(vaultPath, 'categories', '관광.md')
  const linked = await readFile(tourism, 'utf8')
  expect(linked).toContain('[A 여행 안내서.txt]')
  expect(linked).toContain('[B 자료.txt]')
  expect(await readdir(join(vaultPath, 'categories'))).not.toContain('관광 (2).md')
  const note = await readFile(second, 'utf8')
  expect(note).toContain('산업군 · [관광]')
  expect(note).toContain('문서 종류 · [안전 점검표]')
  const marker = /<!-- tandem:wiki-scope ([A-Za-z0-9+/=]+) -->/.exec(note)
  expect(JSON.parse(Buffer.from(marker![1]!, 'base64').toString('utf8'))).toEqual({
    documentType: '안전 점검표',
    industry: '관광',
  })
})
