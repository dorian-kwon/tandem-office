import { sha256Hex } from '@genoffice/pdf-structure'
import { EPUB_METADATA_PAGE, type EpubTranslationUnit } from './units'

/** A saved overview belongs to these source bytes and this confirmed chapter selection. */
export function epubOverviewScope(docHash: string, units: readonly EpubTranslationUnit[]): string {
  const chapters = new Set<number>()
  for (const unit of units) if (unit.page !== EPUB_METADATA_PAGE) chapters.add(unit.page)
  return `epub-v1:${docHash}:${sha256Hex([...chapters].join(','))}`
}

function samplePositions(count: number, limit: number): Set<number> {
  const size = Math.min(count, limit)
  return new Set(
    Array.from({ length: size }, (_, i) => Math.round((i * (count - 1)) / Math.max(1, size - 1))),
  )
}

const excerpt = (text: string, limit: number) =>
  text
    .slice(0, limit)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\uD800-\uDBFF]$/, '')

// Quote explicit source statements about purpose or readership, without assigning an audience.
const statedIntent =
  /(?:intended for|written for|aimed at|the purpose of|this (?:book|guide) (?:is for|aims to)|public visé|s’adresse à|dirigido a|destinado a|richtet sich an|предназначен|대상 독자|이 책의 목적|을 위한 책|를 위한 책|対象読者|本書の目的|目标读者|目標讀者|本书旨在|本書旨在)/iu

/** Local, source-only evidence. The selected passages span the book even if its opening is a glossary. */
export function buildEpubOverview(units: readonly EpubTranslationUnit[]): string {
  let bodyCount = 0
  let contentsCount = 0
  let title = ''
  for (const unit of units) {
    if (unit.page !== EPUB_METADATA_PAGE) bodyCount++
    else {
      if (!title && unit.sources.some((s) => s.kind === 'title'))
        title = excerpt(unit.plainText, 160)
      if (unit.sources.some((s) => s.kind === 'nav' || s.kind === 'ncx')) contentsCount++
    }
  }
  const bodyPositions = samplePositions(bodyCount, 5)
  const contentsPositions = samplePositions(contentsCount, 7)
  const contents: string[] = []
  const passages: string[] = []
  const declarations: string[] = []
  let bodyIndex = 0
  let contentsIndex = 0
  for (const unit of units) {
    if (unit.page !== EPUB_METADATA_PAGE) {
      if (declarations.length < 2) {
        const head = excerpt(unit.plainText, 160)
        if (statedIntent.test(head) && !declarations.includes(head)) declarations.push(head)
      }
      if (bodyPositions.has(bodyIndex++)) {
        passages.push(`Chapter ${unit.page + 1}: ${excerpt(unit.plainText, 210)}`)
      }
    } else if (unit.sources.some((s) => s.kind === 'nav' || s.kind === 'ncx')) {
      if (contentsPositions.has(contentsIndex++)) contents.push(excerpt(unit.plainText, 84))
    }
  }
  return [
    ...(title ? [`Book title: ${title}`] : []),
    ...(contents.length ? [`Contents: ${contents.join(' · ')}`] : []),
    ...(declarations.length ? ['Stated purpose or readership:', ...declarations] : []),
    ...(passages.length ? ['Source excerpts:', ...passages] : []),
  ].join('\n')
}
