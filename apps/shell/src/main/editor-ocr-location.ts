import { BrowserWindow } from 'electron'
import { extname } from 'node:path'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import { openZipFile } from '@genoffice/docx-engine/zip-splice'
import { escapeXmlAttr } from '../../../../packages/docx-engine/src/xml-utils'
import { fileConversionText } from '../renderer/src/i18n/strings-file-conversion'
import { translateText } from '../renderer/src/i18n/strings-translate'
import { parseOcrDestination } from '../renderer/src/translate/ocr-destination-text'
import type { OcrPlacement, OcrTable } from '../shared/translate-ocr'
import type { CliRunner } from './mcp/cli-runner'
import { nativeSheetDestination, nativeOcrSheetNames } from './native-sheet-ocr-action'
import { wordTables } from './translate/ocr-word-tables'
import { readOcrZipPart } from './translate/embedded-images'

export type EditorOcrLocation =
  | { kind: 'native'; placement: 'replace' | 'below' }
  | { kind: 'pdf' }
  | { kind: 'chosen'; placement?: OcrPlacement }
export async function pickEditorOcrLocation(
  owner: BrowserWindow,
  lang: Lang,
  path: string,
  cli: CliRunner,
  keepFormatting: boolean,
): Promise<EditorOcrLocation | null> {
  const f = (k: Parameters<typeof fileConversionText>[1]) => fileConversionText(lang, k)
  const t = (k: Parameters<typeof translateText>[1]) => translateText(lang, k)
  const ext = extname(path).toLowerCase(),
    word = ext === '.docx',
    sheet = ['.xls', '.xlsx', '.xlsm'].includes(ext)
  const names = sheet ? await nativeOcrSheetNames(path, cli) : []
  let tables: OcrTable[] = []
  if (word) {
    const zip = await openZipFile(path)
    try {
      const part = zip.entries.get('word/document.xml')
      if (part)
        tables = wordTables((await readOcrZipPart(zip, part, 64 * 1024 * 1024)).toString('utf8'))
    } finally {
      await zip.close()
    }
  }
  const labels: Parameters<typeof parseOcrDestination>[3] = [
    ['docx-replace-images', f('ocrReplaceImage')],
    ['docx-after-images', f('ocrBelowImage')],
    ['docx-before-images', f('ocrBeforeImage')],
    ['docx-next-page', f('ocrNextPage')],
    ['docx-end', t('ocrDocumentEnd')],
  ]
  const examples: { kind: string; text: string; result: EditorOcrLocation }[] = []
  if (keepFormatting || word || sheet) {
    for (const [kind, text] of labels.slice(0, 2))
      examples.push({
        kind,
        text,
        result: { kind: 'native', placement: kind === 'docx-replace-images' ? 'replace' : 'below' },
      })
  }
  if (word) {
    for (const [kind, text] of labels.slice(2))
      examples.push({ kind, text, result: { kind: 'chosen', placement: { kind } as OcrPlacement } })
    for (const table of tables.slice(0, 1)) {
      const text =
        lang === 'ko' ? `표 ${table.index}의 1행 1열` : `Table ${table.index} row 1 column 1`
      examples.push({
        kind: 'docx-table-cell',
        text,
        result: {
          kind: 'chosen',
          placement: {
            kind: 'docx-table-cell',
            table: table.index,
            row: 1,
            column: 1,
            overwrite: false,
          },
        },
      })
    }
  } else if (sheet) {
    for (const name of names.slice(0, 5))
      examples.push({
        kind: 'xlsx-cells',
        text: name + '!A1',
        result: {
          kind: 'chosen',
          placement: { kind: 'xlsx-cells', sheet: name, cell: 'A1', overwrite: false },
        },
      })
    let fresh = 'OCR'
    for (let i = 2; names.some((n) => n.toLowerCase() === fresh.toLowerCase()); i++)
      fresh = 'OCR ' + i
    examples.push({
      kind: 'xlsx-new-sheet',
      text: t('ocrNewSheet') + ' ' + fresh,
      result: { kind: 'chosen', placement: { kind: 'xlsx-new-sheet', sheet: fresh } },
    })
  } else examples.push({ kind: 'new-document', text: f('ocrWord'), result: { kind: 'chosen' } })
  if (keepFormatting) examples.push({ kind: 'pdf', text: f('ocrPdf'), result: { kind: 'pdf' } })
  const resolve = (text: string): EditorOcrLocation | null => {
    const match = examples.find((e) => e.text === text.trim())
    if (match) return match.result
    const loc = parseOcrDestination(text, sheet, names, labels)
    if (!loc) return null
    const simple = examples.find((e) => e.kind === loc.kind)
    if (!sheet && loc.kind !== 'docx-table-cell') return simple?.result ?? null
    if (word && loc.kind === 'docx-table-cell') {
      const target = tables.find((x) => x.index === Number(loc.table)),
        row = Number(loc.row),
        column = Number(loc.column)
      if (target && row >= 1 && row <= target.rows && column >= 1 && column <= target.columns)
        return {
          kind: 'chosen',
          placement: { kind: loc.kind, table: target.index, row, column, overwrite: false },
        }
    }
    if (sheet && (loc.kind === 'xlsx-cells' || loc.kind === 'xlsx-new-sheet')) {
      try {
        return {
          kind: 'chosen',
          placement: nativeSheetDestination(names, {
            kind: loc.kind === 'xlsx-cells' ? 'existing' : 'new',
            sheet: loc.sheet ?? '',
            cell: loc.cell ?? '',
          }),
        }
      } catch {
        return null
      }
    }
    return null
  }
  if (owner.isDestroyed()) return null
  const title = t('ocrPlaceTitle')
  const modal = new BrowserWindow({
    parent: owner,
    modal: true,
    show: false,
    width: 510,
    height: 390,
    title,
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  modal.webContents.on('will-navigate', (e) => e.preventDefault())
  const esc = escapeXmlAttr
  const closed = new Promise<null>((r) => modal.once('closed', () => r(null)))
  const page = `<!doctype html><html lang="${htmlLang(lang)}" dir="${htmlDir(lang)}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'"><style>:root{color-scheme:light dark;font:15px system-ui}body{margin:22px}button,input{font:inherit;padding:6px 10px}section{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}label,input{display:block}input{box-sizing:border-box;width:100%;margin-top:5px}footer{display:flex;justify-content:end;gap:8px}#error{min-height:1em}</style><body data-testid="editor-ocr-location"><h3>${esc(title)}</h3><section>${examples.map((e) => '<button type="button" data-kind="' + e.kind + '">' + esc(e.text) + '</button>').join('')}</section><form><label>${esc(f('ocrTypePlacement'))}<input autofocus id="location" maxlength="160" value="${esc(examples[0]!.text)}"></label><p id="error" role="status"></p><footer><button type="button" id="cancel">${esc(t('cancel'))}</button><button id="next">${esc(t('ocrNext'))}</button></footer></form></body></html>`
  try {
    await modal.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
    if (modal.isDestroyed()) return null
    if (owner.isVisible()) modal.show()
    const input = `new Promise(resolve=>{const field=document.querySelector('#location');document.querySelectorAll('[data-kind]').forEach(b=>b.onclick=()=>{field.value=b.textContent;field.focus();document.querySelector('#error').textContent='' });document.querySelector('form').onsubmit=e=>{e.preventDefault();resolve(field.value)};document.querySelector('#cancel').onclick=()=>resolve(null);document.onkeydown=e=>{if(e.key==='Escape')resolve(null)}})`
    while (!modal.isDestroyed()) {
      const value = await Promise.race([closed, modal.webContents.executeJavaScript(input)])
      if (value === null || modal.isDestroyed()) return null
      const result = resolve(value)
      if (result) return result
      await modal.webContents.executeJavaScript(
        'document.querySelector("#error").textContent=' + JSON.stringify(f('ocrInvalidPlacement')),
      )
    }
    return null
  } finally {
    if (!modal.isDestroyed()) modal.destroy()
  }
}
