import type { OcrPlacement } from './translate-ocr'
import type { AiReadPagePayload } from '../../../../packages/pdf-structure/src/ai-read/content'
import { readAiReadPayload } from '../../../../packages/pdf-structure/src/ai-read/payload'
import { checkOcrBoxesPayload, type OcrBox } from './ocr-boxes'
/** A reading made of plain text: one paragraph per blank-line separated block. */
export function textPayload(text: string) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  return {
    version: 1,
    blocks: blocks.map((block) => ({
      kind: 'paragraph',
      runs: [{ kind: 'text', text: block }],
    })),
    footnotes: [],
    droppedRepetitions: 0,
    reasked: false,
  }
}
/** One recognised picture as the asking AI panel receives it. */
export interface OcrPopupPage {
  /** 1-based picture number in the listing */
  index: number
  /** where the picture sits, for example `Sheet1 · A7` */
  location: string
  text: string
  /** a Word picture read as the places of its text; `text` is all of them in reading order */
  boxes?: OcrBox[]
  /** The checked page structure when a recognized table must remain editable. */
  form?: AiReadPagePayload
}

/** A picture the popup could not get text from: nothing found, or the reading failed. */
export interface OcrPopupUnread {
  index: number
  location: string
  reason: 'empty' | 'failed'
}

/** The local placement analysis the popup carries back (never an extra model call). */
export interface OcrPopupRecommendation {
  /** the structured placement `ocr-recommendation.ts` proposed */
  placement: unknown
  reason: 'empty-cells' | 'new-sheet' | 'after-images'
}

/** What the OCR popup returns once the person confirmed and the pictures were read. */
export type OcrPicturePlacement =
  'docx-replace-images' | 'docx-after-images' | 'docx-before-images' | 'docx-next-page'
export interface OcrPopupResult {
  placement?: OcrPlacement
  newDocument?: true
  referenceOnly?: true
  picturePlacement?: OcrPicturePlacement
  pages: OcrPopupPage[]
  /** pictures that gave no text when the person went on without them */
  unread?: OcrPopupUnread[]
  recommendation?: OcrPopupRecommendation
}

/** Plain text of one recognised page payload (blocks, runs and tables flattened). */
export function ocrPayloadPlainText(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(ocrPayloadPlainText).filter(Boolean).join('\n')
  const obj = value as Record<string, unknown>
  if (typeof obj.text === 'string') return obj.text
  return Object.values(obj).map(ocrPayloadPlainText).filter(Boolean).join('\n')
}

export const OCR_POPUP_MAX_PAGES = 500
export const OCR_POPUP_MAX_TEXT = 200_000
export const OCR_POPUP_MAX_TOTAL = 4 * 1024 * 1024

/**
 * Check what a popup renderer sent back before main hands it to another window: plain
 * strings and numbers only, bounded in count and size. Throws on anything else.
 */
export function checkOcrPopupResult(value: unknown): OcrPopupResult {
  const bad = (): never => {
    throw new Error('Invalid OCR popup result')
  }
  if (!value || typeof value !== 'object') return bad()
  const raw = value as Partial<OcrPopupResult>
  if (!Array.isArray(raw.pages) || raw.pages.length > OCR_POPUP_MAX_PAGES) return bad()
  let total = 0
  const pages = raw.pages.map((p): OcrPopupPage => {
    const page = p as Partial<OcrPopupPage> | null
    if (
      !page ||
      !Number.isInteger(page.index) ||
      (page.index as number) < 1 ||
      typeof page.location !== 'string' ||
      page.location.length > 500 ||
      typeof page.text !== 'string' ||
      page.text.length > OCR_POPUP_MAX_TEXT
    )
      return bad()
    total += page.text.length
    const out: OcrPopupPage = {
      index: page.index as number,
      location: page.location,
      text: page.text,
    }
    if (page.form !== undefined) {
      const size = JSON.stringify(page.form)?.length
      if (!size || size > OCR_POPUP_MAX_TOTAL - total || page.boxes !== undefined) return bad()
      const form = readAiReadPayload(page.form)
      if (!form || (!raw.newDocument && !form.blocks.some((block) => block.kind === 'table')))
        return bad()
      out.form = form
      total += size
    }
    if (page.boxes !== undefined) {
      // the boxes are checked the way main checks a box reading before it writes one
      const checked = checkOcrBoxesPayload({ kind: 'boxes', boxes: page.boxes, text: page.text })
      if (!checked) return bad()
      out.boxes = checked.boxes
    }
    return out
  })
  if (total > OCR_POPUP_MAX_TOTAL) return bad()
  const result: OcrPopupResult = { pages }
  if (raw.newDocument !== undefined || raw.referenceOnly !== undefined) {
    if (
      (raw.newDocument !== undefined && raw.newDocument !== true) ||
      (raw.referenceOnly !== undefined && raw.referenceOnly !== true) ||
      (raw.newDocument && raw.referenceOnly) ||
      raw.placement !== undefined
    )
      return bad()
    if (raw.newDocument) result.newDocument = true
    if (raw.referenceOnly) result.referenceOnly = true
  }
  const place = raw.placement
  if (place !== undefined) {
    if (!place || typeof place !== 'object') return bad()
    switch (place.kind) {
      case 'docx-end':
      case 'docx-before-images':
      case 'docx-next-page':
      case 'docx-after-images':
      case 'docx-replace-images':
        result.placement = { kind: place.kind }
        break
      case 'docx-table-cell':
        if (
          ![place.table, place.row, place.column].every((n) => Number.isSafeInteger(n) && n > 0) ||
          typeof place.overwrite !== 'boolean'
        )
          return bad()
        result.placement = {
          kind: place.kind,
          table: place.table,
          row: place.row,
          column: place.column,
          overwrite: place.overwrite,
        }
        break
      case 'xlsx-new-sheet':
      case 'xlsx-cells':
        if (typeof place.sheet !== 'string' || !place.sheet.trim() || place.sheet.length > 31)
          return bad()
        if (place.kind === 'xlsx-new-sheet')
          result.placement = { kind: place.kind, sheet: place.sheet }
        else {
          if (
            typeof place.cell !== 'string' ||
            !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(place.cell) ||
            typeof place.overwrite !== 'boolean'
          )
            return bad()
          result.placement = {
            kind: place.kind,
            sheet: place.sheet,
            cell: place.cell,
            overwrite: place.overwrite,
          }
        }
        break
      case 'docx-image-boxes':
        // Derive coordinates from the checked readings for these exact pictures.
        result.placement = {
          kind: place.kind,
          images: pages.flatMap((p) =>
            p.boxes?.length ? [{ index: p.index, boxes: p.boxes }] : [],
          ),
        }
        break
      default:
        return bad()
    }
  }
  if (raw.picturePlacement !== undefined) {
    if (
      raw.picturePlacement !== 'docx-replace-images' &&
      raw.picturePlacement !== 'docx-before-images' &&
      raw.picturePlacement !== 'docx-next-page' &&
      raw.picturePlacement !== 'docx-after-images'
    )
      return bad()
    result.picturePlacement = raw.picturePlacement
  }
  const rawUnread = (value as { unread?: unknown }).unread
  if (rawUnread !== undefined) {
    if (!Array.isArray(rawUnread) || rawUnread.length > OCR_POPUP_MAX_PAGES) return bad()
    result.unread = rawUnread.map((u): OcrPopupUnread => {
      const item = u as Partial<OcrPopupUnread> | null
      if (
        !item ||
        !Number.isInteger(item.index) ||
        (item.index as number) < 1 ||
        typeof item.location !== 'string' ||
        item.location.length > 500 ||
        (item.reason !== 'empty' && item.reason !== 'failed')
      )
        return bad()
      return { index: item.index as number, location: item.location, reason: item.reason }
    })
  }
  const rec = raw.recommendation as Partial<OcrPopupRecommendation> | undefined
  if (rec !== undefined) {
    if (
      !rec ||
      !['empty-cells', 'new-sheet', 'after-images'].includes(rec.reason as string) ||
      JSON.stringify(rec.placement ?? null).length > 4096
    )
      return bad()
    result.recommendation = { placement: rec.placement, reason: rec.reason as never }
  }
  return result
}
