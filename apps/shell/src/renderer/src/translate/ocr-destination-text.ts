import type { OcrPlacement } from '../../../shared/translate-ocr'

export interface OcrDestinationFields {
  kind: OcrPlacement['kind'] | 'reference-only'
  table?: string
  row?: string
  column?: string
  sheet?: string
  cell?: string
}

type SimpleDestination =
  | Extract<
      OcrPlacement,
      {
        kind:
          | 'docx-before-images'
          | 'docx-after-images'
          | 'docx-next-page'
          | 'docx-replace-images'
          | 'docx-end'
          | 'docx-image-boxes'
      }
    >['kind']
  | 'reference-only'

const koreanWordLocations: [RegExp, SimpleDestination][] = [
  [
    /^(?:각\s*)?(?:그림|이미지|사진)\s*(?:의\s*)?(?:바로\s*)?(?:앞(?:쪽)?|이전|전)$/,
    'docx-before-images',
  ],
  [
    /^(?:각\s*)?(?:그림|이미지|사진)\s*(?:의\s*)?(?:바로\s*)?(?:뒤(?:쪽)?|아래(?:쪽)?|밑|다음)$/,
    'docx-after-images',
  ],
  [/^(?:(?:그림|이미지)\s*(?:의\s*)?)?다음\s*(?:페이지|쪽|장)$/, 'docx-next-page'],
  [/^(?:원본\s*)?(?:그림|이미지|사진)(?:을|를)?\s*(?:교체|대체)$/, 'docx-replace-images'],
  [/^(?:문서\s*(?:의\s*)?)?(?:맨\s*)?(?:끝|마지막)$/, 'docx-end'],
]
const englishWordLocations: [RegExp, SimpleDestination][] = [
  [/^before (?:each |the )?(?:image|picture)$/, 'docx-before-images'],
  [/^(?:after|below) (?:each |the )?(?:image|picture)$/, 'docx-after-images'],
  [/^(?:on (?:the )?)?next page$/, 'docx-next-page'],
  [/^replace (?:each |the )?(?:image|picture)$/, 'docx-replace-images'],
  [/^(?:at (?:the )?)?end of (?:the )?document$/, 'docx-end'],
]

/** Interpret a location locally. The picker applies the same document bounds and overwrite rules as a menu selection. */
export function parseOcrDestination(
  value: string,
  xlsx: boolean,
  sheets: readonly string[],
  labels: readonly (readonly [SimpleDestination, string])[],
): OcrDestinationFields | null {
  const text = value.normalize('NFKC').trim().replace(/\s+/g, ' ')
  if (!text) return null
  const exact = labels.find(
    ([, label]) => label.normalize('NFKC').toLowerCase() === text.toLowerCase(),
  )
  if (exact) return { kind: exact[0] }
  if (xlsx) {
    const cell = /^(?:(?:'((?:''|[^'])+)'|(.+))!\s*)?\$?([a-z]{1,3})\$?([1-9]\d*)$/i.exec(text)
    if (cell) {
      const sheetName =
        cell[1]?.replace(/''/g, "'") ?? cell[2] ?? (sheets.length === 1 ? sheets[0] : undefined)
      const sheet = sheets.find((name) => name.toLowerCase() === sheetName?.toLowerCase())
      return sheet ? { kind: 'xlsx-cells', sheet, cell: cell[3]!.toUpperCase() + cell[4] } : null
    }
    const newSheet = /^(?:새\s*시트|new sheet)\s*[:：]?\s+(.+)$/i.exec(text)
    return newSheet ? { kind: 'xlsx-new-sheet', sheet: newSheet[1]!.trim() } : null
  }
  const request = text
    .toLowerCase()
    .replace(/[.!。]+$/, '')
    .replace(
      /(?:에|으로|로)?\s*(?:넣어\s*(?:줘|주세요)|삽입해\s*(?:줘|주세요)|추가해\s*(?:줘|주세요)|배치해\s*(?:줘|주세요))$/,
      '',
    )
    .replace(/(?:에|으로|로)$/, '')
    .trim()
  const table =
    /^(?:표\s*(\d+)\s*(?:번\s*)?(?:의\s*)?|(\d+)\s*번\s*표\s*(?:의\s*)?)(\d+)\s*행\s*[,·]?\s*(\d+)\s*열$/.exec(
      request,
    )
  if (table)
    return { kind: 'docx-table-cell', table: table[1] ?? table[2], row: table[3], column: table[4] }
  const englishTable =
    /^table\s+(\d+)\s*[,·]?\s*row\s+(\d+)\s*[,·]?\s*(?:col|column)\s+(\d+)$/.exec(request)
  if (englishTable)
    return {
      kind: 'docx-table-cell',
      table: englishTable[1],
      row: englishTable[2],
      column: englishTable[3],
    }
  for (const [pattern, kind] of [...koreanWordLocations, ...englishWordLocations])
    if (pattern.test(request)) return { kind }
  return null
}
