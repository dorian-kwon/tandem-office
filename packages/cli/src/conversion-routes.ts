import type { AppExportTarget } from './formats/app-export'

/** Conversions that run in this process. */
const NODE_ROUTES: Record<string, readonly string[]> = {
  pdf: ['docx', 'pptx', 'xlsx', 'md', 'epub'],
  csv: ['xlsx', 'tsv'],
  tsv: ['xlsx', 'csv'],
  xls: ['xlsx'],
  xlsb: ['xlsx'],
  ods: ['xlsx'],
  md: ['docx', 'html'],
  markdown: ['docx', 'html'],
  docx: ['md'],
  xlsx: ['csv', 'tsv', 'ods'],
  xlsm: ['csv', 'tsv', 'xlsx', 'ods'],
  json: ['txt'],
  txt: ['json'],
}

/**
 * Conversions the GenOffice binary runs for us in its hidden headless-export
 * mode: anything that needs an app renderer (page layout for pdf, the Word
 * editor's HTML export, html2docx, the Hangul editor's pages). Mirrors
 * HEADLESS_TARGETS in the shell.
 */
const APP_ROUTES: Record<string, readonly AppExportTarget[]> = {
  pdf: ['html'],
  csv: ['pdf'],
  tsv: ['pdf'],
  xls: ['pdf'],
  md: ['pdf'],
  markdown: ['pdf'],
  docx: ['pdf', 'html'],
  xlsx: ['pdf'],
  xlsm: ['pdf'],
  pptx: ['pdf'],
  html: ['pdf', 'docx'],
  htm: ['pdf', 'docx'],
  hwp: ['pdf'],
  hwpx: ['pdf'],
}

/**
 * OpenDocument text routes. They pass through a docx: an .odt is opened as
 * its bridge docx (odtToDocx) and goes on along the docx routes (the app's
 * headless export does not take .odt, so pdf/html read a temporary docx);
 * docx, md and html reach .odt through docx and docxToOdt.
 */
const ODT_ROUTES: Record<string, readonly string[]> = {
  odt: ['docx', 'pdf', 'md', 'html'],
  docx: ['odt'],
  md: ['odt'],
  markdown: ['odt'],
  html: ['odt'],
  htm: ['odt'],
}

const hangulTargets = ['hwp', 'hwpx'] as const
const editableTargets = [
  'docx',
  'odt',
  'html',
  'md',
  'txt',
  'pptx',
  'xlsx',
  'epub',
  'xmind',
] as const
const HANGUL_ROUTES: Record<string, readonly string[]> = {
  hwp: ['hwpx', ...editableTargets],
  hwpx: ['hwp', ...editableTargets],
  ...Object.fromEntries(
    [...editableTargets, 'pdf', 'markdown', 'htm', 'xlsm'].map((format) => [format, hangulTargets]),
  ),
}

// Semantic body bridges preserve editable text, table rows and supported images.
const bodyTargets = ['txt', 'md', 'xlsx', 'epub', 'xmind'] as const
const BODY_ROUTES: Record<string, readonly string[]> = {
  html: bodyTargets,
  htm: bodyTargets,
  txt: ['html'],
  epub: ['html'],
  xmind: ['html'],
  xlsx: ['html'],
  xlsm: ['html'],
}

export function bodyTarget(from: string, to: string): boolean {
  return Object.hasOwn(BODY_ROUTES, from) && BODY_ROUTES[from]!.includes(to)
}

export const DIRECT_CONVERSION_ROUTES: Record<string, readonly string[]> = Object.create(null)
for (const routes of [NODE_ROUTES, APP_ROUTES, ODT_ROUTES, HANGUL_ROUTES, BODY_ROUTES]) {
  for (const [from, targets] of Object.entries(routes)) {
    DIRECT_CONVERSION_ROUTES[from] = [
      ...new Set([...(DIRECT_CONVERSION_ROUTES[from] ?? []), ...targets]),
    ]
  }
}

const outputFormats = [
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
const editableBridges = ['html', 'docx', 'xlsx']
const equivalent: Record<string, string> = { htm: 'html', markdown: 'md' }

/** Prefer editable intermediate documents. Print and reconstruct only when no
 * editable route reaches the target (for example a slide import or export). */
export function conversionPath(from: string, to: string): string[] | null {
  if (from === to || equivalent[from] === to || !DIRECT_CONVERSION_ROUTES[from]) return null
  if (DIRECT_CONVERSION_ROUTES[from]!.includes(to)) return [from, to]
  if (from === 'json' || to === 'json' || !outputFormats.includes(to)) return null
  for (const bridges of [editableBridges, [...editableBridges, 'pdf']]) {
    const queue: string[][] = [[from]]
    const seen = new Set([from])
    for (const path of queue) {
      const edges = DIRECT_CONVERSION_ROUTES[path[path.length - 1]!]!
      if (edges.includes(to)) return [...path, to]
      for (const next of bridges) {
        if (seen.has(next) || !edges.includes(next)) continue
        seen.add(next)
        queue.push([...path, next])
      }
    }
  }
  return null
}

export const CONVERSION_ROUTES: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(DIRECT_CONVERSION_ROUTES).map(([from, direct]) => [
    from,
    [...new Set([...direct, ...outputFormats])].filter((to) => conversionPath(from, to)),
  ]),
)

export function appTarget(from: string, to: string): AppExportTarget | null {
  const target = APP_ROUTES[from]?.find((t) => t === to)
  return target ?? null
}
