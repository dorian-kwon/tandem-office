import type { TranslationBlockKey } from '../store/keys'
import { Sha256 } from '../tree/hash'
import type { DocumentTree, InlineRun } from '../tree/types'
import type { TextUnit } from '../tree/derive'

/** The local source evidence and recently accepted translations sent beside, never as, batch items. */
export interface TranslationBatchContext {
  overview: string
  previous: { source: string; target: string }[]
  /** Prior accepted examples of the same normalized source, with its location in the selected text. */
  matches?: { source: string; target: string; page: number; unit: number }[]
}

export interface TranslationOverview {
  scope: string
  text: string
}

export const OVERVIEW_TEXT_LIMIT = 2400
export const CONTEXT_PAIR_LENGTH = 240
export const CONTEXT_PAIR_COUNT = 2

/** Stop at the character budget even for a single book-sized paragraph. */
export function sourceExcerpt(runs: readonly InlineRun[], length: number): string {
  let result = ''
  for (const run of runs) {
    if (result.length >= length) break
    if (run.kind === 'text') result += run.text.slice(0, length - result.length)
    else if (run.kind === 'lineBreak') result += ' '
  }
  return clip(result, length)
}

const clip = (s: string, n: number) =>
  s
    .slice(0, n)
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[\uD800-\uDBFF]$/, '')

// Quote explicit statements where available. The translator decides what they imply.
const statedIntent =
  /(?:intended for|written for|aimed at|the purpose of|this (?:report|guide|manual) (?:is for|aims to)|대상 독자|(?:보고서|안내서|매뉴얼)의 목적|을 위한 (?:보고서|안내서)|対象読者|本書の目的|目标读者|目標讀者|public visé|dirigido a|richtet sich an)/iu

/** Only original text on the confirmed pages can appear in the overview. */
export function pdfSourceOverview(
  tree: DocumentTree,
  units: readonly TextUnit[],
  selected?: readonly number[],
) {
  const allowed = selected && new Set(selected)
  const pages = tree.pages.filter((p) => !allowed || allowed.has(p.page))
  return {
    scope(keys: readonly TranslationBlockKey[]) {
      const hash = new Sha256().update(JSON.stringify([tree.info.title, tree.info.subject]))
      for (const page of pages)
        hash.update(JSON.stringify([page.page, page.fingerprint, page.status]))
      // AI and OCR can update source readings without changing a page fingerprint.
      // The job has already computed these hashes for block lookup.
      for (const key of keys) hash.update(key.textHash)
      return hash.hex()
    },
    build() {
      const lines: string[] = []
      if (tree.info.title) lines.push('Title: ' + clip(tree.info.title, 180))
      if (tree.info.subject) lines.push('Subject: ' + clip(tree.info.subject, 180))
      const headings: string[] = []
      for (const block of tree.blocks) {
        if (block.kind !== 'heading' || (allowed && !allowed.has(block.page))) continue
        const text = sourceExcerpt(block.runs, 100)
        if (text) headings.push('p' + block.page + ' ' + text)
        if (headings.length === 6) break
      }
      if (headings.length) lines.push('Headings: ' + headings.join(' | '))
      const declarations: string[] = []
      for (const unit of units) {
        const text = sourceExcerpt(unit.runs, 160)
        if (statedIntent.test(text) && !declarations.includes(text)) declarations.push(text)
        if (declarations.length === 2) break
      }
      if (declarations.length)
        lines.push('Stated purpose or readership: ' + declarations.join(' | '))
      const indices = new Set([
        0,
        Math.floor(units.length / 3),
        Math.floor((2 * units.length) / 3),
        units.length - 1,
      ])
      for (const i of indices) {
        const unit = units[i]
        if (unit) lines.push('Excerpt, p' + unit.page + ': ' + sourceExcerpt(unit.runs, 225))
      }
      return lines.join('\n').slice(0, OVERVIEW_TEXT_LIMIT)
    },
  }
}
