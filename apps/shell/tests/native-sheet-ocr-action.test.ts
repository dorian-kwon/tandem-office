import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import { nativeOcrSheetNames, nativeSheetDestination } from '../src/main/native-sheet-ocr-action'

describe('native Excel OCR destination before recognition', () => {
  it('allows a named new sheet or a bounded address on an existing sheet', () => {
    const names = ['Result', 'Source']
    expect(
      nativeSheetDestination(names, { kind: 'existing', sheet: 'Result', cell: ' d4 ' }),
    ).toEqual({ kind: 'xlsx-cells', sheet: 'Result', cell: 'D4', overwrite: false })
    expect(nativeSheetDestination(names, { kind: 'new', sheet: ' 추가 ', cell: '' })).toEqual({
      kind: 'xlsx-new-sheet',
      sheet: '추가',
    })
    expect(() =>
      nativeSheetDestination(names, { kind: 'existing', sheet: 'Result', cell: 'XFE1' }),
    ).toThrow('OCR_SHEET_DESTINATION_INVALID')
    expect(() => nativeSheetDestination(names, { kind: 'new', sheet: 'result', cell: '' })).toThrow(
      'OCR_SHEET_NAME_USED',
    )
  })

  it.each(['xls', 'xlsm'])('reads sheet names for %s without running OCR', async (ext) => {
    const dir = await mkdtemp(join(tmpdir(), 'native-ocr-sheet-list-'))
    try {
      const source = join(dir, 'original.' + ext)
      const zip = new JSZip()
      zip.file(
        'xl/workbook.xml',
        '<workbook><sheets><sheet name="One &amp; Two" sheetId="1" r:id="rId1"/><sheet name="대상" sheetId="2" r:id="rId2"/></sheets></workbook>',
      )
      const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
      await writeFile(source, ext === 'xls' ? Buffer.from('input handled by converter') : data)
      const run = vi.fn(async (args: readonly string[]) => {
        expect(args.slice(0, 5)).toEqual(['convert', source, '--to', 'xlsx', '--out'])
        await writeFile(args[5]!, data)
        return { ok: true, code: 0, stdout: '', stderr: '' }
      })
      expect(await nativeOcrSheetNames(source, { run })).toEqual(['One & Two', '대상'])
      expect(run).toHaveBeenCalledTimes(ext === 'xls' ? 1 : 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
