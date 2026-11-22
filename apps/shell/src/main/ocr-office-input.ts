import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { appForPath } from './app-routing'

type BridgeFormat = 'pdf' | 'docx' | 'html' | 'xlsx'
type Export = (input: string, format: BridgeFormat, output: string) => Promise<void>

/** Prepare one file at a time. The worker receives either the native Word package
 * or the rendered physical pages when page selection or fixed layout matters. */
export async function withOcrInput<T>(
  input: string,
  target: string,
  range: string | undefined,
  exportFile: Export,
  exportSheetHtml: (input: string, output: string) => Promise<void>,
  recognize: (prepared: string) => Promise<T>,
): Promise<T> {
  const ext = extname(input).slice(1).toLowerCase()
  if (['pdf', 'png', 'jpg', 'jpeg'].includes(ext)) return recognize(input)
  const app = appForPath(input)
  if (!app) throw new Error('Unsupported OCR format')
  const format = target === 'pdf' || range?.trim() || app === 'slides' ? 'pdf' : 'docx'
  if (['xlsx', 'xlsm'].includes(target) && ext === target) return recognize(input)
  if (ext === 'docx' && format === 'docx') return recognize(input)

  const dir = await mkdtemp(join(tmpdir(), 'tandem-office-ocr-'))
  try {
    if (target === 'xlsx' && ext === 'xls') {
      const workbook = join(dir, 'book.xlsx')
      await exportFile(input, 'xlsx', workbook)
      return await recognize(workbook)
    }
    let source = input
    const html = join(dir, 'body.html')
    if (app === 'sheets') {
      if (ext === 'xls') {
        source = join(dir, 'book.xlsx')
        await exportFile(input, 'xlsx', source)
      }
      await exportSheetHtml(source, html)
      source = html
    } else if (ext === 'md' || ext === 'markdown') {
      // Resolve linked pictures relative to the original Markdown document.
      source = join(dir, 'body.docx')
      await exportFile(input, 'docx', source)
      if (format === 'docx') return await recognize(source)
    } else if (
      app === 'mindmap' ||
      app === 'epub' ||
      app === 'markdown' ||
      (app === 'hwp' && format === 'docx')
    ) {
      // JSON is edited as literal text, including incomplete JSON.
      if (ext === 'json') {
        source = join(dir, 'source.txt')
        await copyFile(input, source)
      }
      await exportFile(source, 'html', html)
      source = html
    } else if (ext === 'odt' && format === 'pdf') {
      source = join(dir, 'body.docx')
      await exportFile(input, 'docx', source)
    }
    const prepared = join(dir, 'rendered.' + format)
    await exportFile(source, format, prepared)
    return await recognize(prepared)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
