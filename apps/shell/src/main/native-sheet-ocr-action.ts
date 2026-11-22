import { BrowserWindow, dialog } from 'electron'
import { extname } from 'node:path'
import { htmlDir, htmlLang, type Lang } from '@genoffice/i18n'
import { parseSheetElements, validateSheetName } from '@genoffice/xlsx-gateway/gateway/xlsx-sheets'
import { openZipFile } from '@genoffice/docx-engine/zip-splice'
import { readOcrZipPart } from './translate/embedded-images'
import { escapeXmlAttr } from '../../../../packages/docx-engine/src/xml-utils'
import { translateText } from '../renderer/src/i18n/strings-translate'
import { cliErrorMessage, type CliRunner } from './mcp/cli-runner'
import type { ExcelOcrDestination } from './ocr-office-workbook'
import { withOcrInput } from './ocr-office-input'
import { cellPosition } from './translate/ocr-xlsx-structure'
export type { ExcelOcrDestination } from './ocr-office-workbook'

/** Only workbook metadata is opened before the user chooses a destination. Legacy XLS is
 * inspected through the same temporary XLSX conversion used by the OCR writer. */
export async function nativeOcrSheetNames(path: string, cli: CliRunner): Promise<string[]> {
  const ext = extname(path).toLowerCase()
  if (!['.xls', '.xlsx', '.xlsm'].includes(ext)) throw Error('OCR_SHEET_DESTINATION_INVALID')
  const format = ext === '.xlsm' ? 'xlsm' : 'xlsx'
  return withOcrInput(
    path,
    format,
    undefined,
    async (source, target, output) => {
      const result = await cli.run(['convert', source, '--to', target, '--out', output], {
        timeoutMs: 600_000,
      })
      if (!result.ok) throw Error(cliErrorMessage(result))
    },
    async () => {
      throw Error('OCR_SHEET_DESTINATION_INVALID')
    },
    async (prepared) => {
      const zip = await openZipFile(prepared)
      try {
        const entry = zip.entries.get('xl/workbook.xml')
        if (!entry) throw Error('OCR_SHEET_DESTINATION_INVALID')
        const xml = await readOcrZipPart(zip, entry, 4 * 1024 * 1024)
        return parseSheetElements(xml.toString('utf8')).map((sheet) => sheet.name)
      } finally {
        await zip.close()
      }
    },
  )
}

export function nativeSheetDestination(
  names: string[],
  result: { kind: string; sheet: string; cell: string },
): ExcelOcrDestination {
  if (result.kind === 'new') {
    const name = result.sheet.trim()
    validateSheetName(name)
    if (names.some((s) => s.toLowerCase() === name.toLowerCase()))
      throw Error('OCR_SHEET_NAME_USED')
    return { kind: 'xlsx-new-sheet', sheet: name }
  }
  const cell = result.cell.trim().toUpperCase()
  if (result.kind !== 'existing' || !names.includes(result.sheet) || !cellPosition(cell))
    throw Error('OCR_SHEET_DESTINATION_INVALID')
  return { kind: 'xlsx-cells', sheet: result.sheet, cell, overwrite: false }
}

/** Local modal, with no preload or network. Excel may have names containing arbitrary markup. */
export async function pickNativeSheetOcrDestination(
  owner: BrowserWindow,
  lang: Lang,
  path: string,
  cli: CliRunner,
): Promise<ExcelOcrDestination | undefined> {
  const names = await nativeOcrSheetNames(path, cli)
  if (owner.isDestroyed()) return
  const t = (key: Parameters<typeof translateText>[1]) => escapeXmlAttr(translateText(lang, key))
  const title = translateText(lang, 'ocrPlaceTitle')
  const modal = new BrowserWindow({
    parent: owner,
    modal: true,
    show: false,
    useContentSize: true,
    width: 430,
    height: 325,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
  })
  modal.removeMenu()
  modal.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  modal.webContents.on('will-navigate', (e) => e.preventDefault())
  const closed = new Promise<undefined>((resolve) => modal.once('closed', () => resolve(undefined)))
  const suggested = new Set(names.map((s) => s.toLowerCase()))
  let newName = 'OCR'
  for (let i = 2; suggested.has(newName.toLowerCase()); i++) newName = 'OCR ' + i
  const options = names.map((s) => '<option>' + escapeXmlAttr(s) + '</option>').join('')
  const html = `<!doctype html><html lang="${htmlLang(lang)}" dir="${htmlDir(lang)}"><head>
    <meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
    <style>:root{color-scheme:light dark;font:14px system-ui}body{margin:22px}form,label{display:grid;gap:7px}form{gap:15px}input,select,button{font:inherit;padding:6px 9px}footer{display:flex;gap:8px;justify-content:end}button{min-width:72px}[hidden]{display:none}</style></head>
    <body><form id="form"><label>${t('ocrPlaceTitle')}<select id="kind"><option value="existing">${t('ocrExistingCells')}</option><option value="new">${t('ocrNewSheet')}</option></select></label>
    <label id="sheetField">${t('ocrSheetName')}<select id="existing">${options}</select></label>
    <label id="nameField" hidden>${t('ocrSheetName')}<input id="name" maxlength="31" value="${escapeXmlAttr(newName)}"></label>
    <label id="cellField">${t('ocrStartCell')}<input id="cell" value="A1" maxlength="10"></label>
    <footer><button type="button" id="cancel">${t('cancel')}</button><button type="submit">${t('ocrStart')}</button></footer></form></body></html>`
  try {
    await modal.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    if (modal.isDestroyed()) return
    // DOM values cross back as data. Workbook names and locale strings are never evaluated.
    const setup = `new Promise(resolve => {
      const byId = id => document.getElementById(id);
      const kind = byId('kind');
      kind.onchange = () => {
        const isNew = kind.value === 'new';
        byId('nameField').hidden = !isNew;
        byId('cellField').hidden = byId('sheetField').hidden = isNew;
      };
      byId('cancel').onclick = () => resolve(null);
      document.onkeydown = e => { if (e.key === 'Escape') resolve(null); };
      byId('form').onsubmit = e => {
        e.preventDefault();
        resolve({kind:kind.value, sheet:byId(kind.value === 'new' ? 'name' : 'existing').value, cell:byId('cell').value});
      };
    })`
    if (owner.isVisible()) modal.show()
    while (!modal.isDestroyed()) {
      const selected = await Promise.race([closed, modal.webContents.executeJavaScript(setup)])
      if (!selected || modal.isDestroyed()) return
      try {
        return nativeSheetDestination(names, selected)
      } catch (error) {
        if (modal.isDestroyed()) return
        await dialog.showMessageBox(modal, {
          type: 'warning',
          message: title,
          detail:
            error instanceof Error && error.message === 'OCR_SHEET_NAME_USED'
              ? translateText(lang, 'ocrNewSheet') + ' · ' + selected.sheet
              : translateText(lang, 'ocrSheetName') +
                ' / ' +
                translateText(lang, 'ocrStartCell') +
                ' (A1–XFD1048576)',
        })
      }
    }
  } catch (error) {
    if (!modal.isDestroyed()) throw error
  } finally {
    if (!modal.isDestroyed()) modal.destroy()
  }
}
