// @vitest-environment jsdom
import { IUndoRedoService, LocaleType, LogLevel, Univer, type IUndoRedoItem } from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { afterEach, expect, it } from 'vitest'
import { createAiUndoScope, matchesAiUndoEntries } from '../src/renderer/ai-undo-scope'
import { adapterHistoryCells } from '../src/renderer/adapter-ai-history'
import { loadSnapshotIntoUniver, pushVisualUndo } from '../src/renderer/univer-sync'
import {
  captureUndoCarry,
  consumePendingUndoCarry,
  currentUndoStack,
  stashUndoCarry,
} from '../src/renderer/undo-carry'
import {
  AI_UNDO_CELL_BUDGET,
  installJournalSuppressionUndoFilter,
  undoPayloadCells,
  type UniverRuntime,
} from '../src/renderer/univer-state'

const empty = { revision: 0, sheets: [{ id: 's', name: 'Sheet1', cells: {} }] }
let runtime: UniverRuntime
function open() {
  installJournalSuppressionUndoFilter()
  const univer = new Univer({ logLevel: LogLevel.SILENT, locale: LocaleType.EN_US, locales: {} })
  univer.registerPlugin(UniverSheetsPlugin)
  runtime = { univer, univerAPI: FUniver.newAPI(univer) } as unknown as UniverRuntime
  loadSnapshotIntoUniver(runtime, empty, 'file-old', 'Workbook')
  return univer.__getInjector().get(IUndoRedoService)
}
afterEach(() => runtime?.univer.dispose())

function ai(commit: () => void) {
  const scope = createAiUndoScope(true)
  scope.run(commit)
  scope.settle()
  return scope
}

// Same mutation payload as Univer's setRangeValues command. Use the actual
// service with separate before/after matrices for every simulated proposal.
function cellItem(unitID: string, cells: number, value: string): IUndoRedoItem {
  const mutation = (text: string) => ({
    id: 'sheet.mutation.set-range-values',
    params: {
      unitId: unitID,
      subUnitId: 's',
      cellValue: Object.fromEntries(
        Array.from({ length: cells / 100 }, (_, row) => [
          row,
          Array.from({ length: 100 }, () => ({ v: text })),
        ]),
      ),
    },
  })
  return { unitID, undoMutations: [mutation('old')], redoMutations: [mutation(value)] }
}

it('bounds many small translation proposals on the actual stack and preserves intervening manual edits', () => {
  const service = open()
  const edit = runtime.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange('A1')
  edit.setValue('first manual')
  const manual = [service.pitchTopUndoElement()!]
  for (let turn = 0; turn < 32; turn++) {
    if (turn === 10) {
      edit.setValue('second manual')
      manual.push(service.pitchTopUndoElement()!)
    }
    const receipt = ai(() => service.pushUndoRedo(cellItem('file-old', 12_500, String(turn))))
    const stack = currentUndoStack(runtime) as readonly IUndoRedoItem[]
    expect(receipt.dropped).toBe(false)
    expect(matchesAiUndoEntries(stack, receipt.entryIds)).toBe(true)
    const aiCells = stack
      .filter((item) => !manual.includes(item))
      .reduce((sum, item) => sum + undoPayloadCells(item, AI_UNDO_CELL_BUDGET), 0)
    expect(aiCells).toBeLessThanOrEqual(AI_UNDO_CELL_BUDGET)
    for (const entry of manual) expect(stack.includes(entry)).toBe(true)
  }
  expect(currentUndoStack(runtime)).toHaveLength(10)
})

it('keeps a structural AI inverse between manual edits when making room', async () => {
  const service = open()
  const sheet = runtime.univerAPI.getActiveWorkbook()!.getActiveSheet()
  sheet.getRange('A1').setValue('moves with the row')
  const first = service.pitchTopUndoElement()
  ai(() => sheet.insertRowsBefore(0, 1))
  const structural = service.pitchTopUndoElement()
  sheet.getRange('A1').setValue('new first row')
  const second = service.pitchTopUndoElement()
  for (let i = 0; i < 5; i++)
    ai(() => service.pushUndoRedo(cellItem('file-old', 40_000, String(i))))
  const stack = currentUndoStack(runtime)
  expect(stack.slice(0, 3)).toEqual([first, structural, second])
  while (service.pitchTopUndoElement() !== second) service.popUndoToRedo()
  await runtime.univerAPI.undo()
  await runtime.univerAPI.undo()
  expect(sheet.getRange('A1').getValue()).toBe('moves with the row')
  await runtime.univerAPI.undo()
  expect(sheet.getRange('A1').getValue()).toBeNull()
})

it('declines a new record when a large structural undo protects earlier manual coordinates', () => {
  const service = open()
  const sheet = runtime.univerAPI.getActiveWorkbook()!.getActiveSheet()
  sheet.getRange('A1').setValue('manual')
  const manual = service.pitchTopUndoElement()
  const structural = ai(() => {
    sheet.insertRowsBefore(0, 1)
    service.pushUndoRedo(cellItem('file-old', 70_000, 'translated'))
  })
  expect(structural.dropped).toBe(false)
  const protectedEntry = service.pitchTopUndoElement()
  const later = ai(() => service.pushUndoRedo(cellItem('file-old', 40_000, 'next')))
  expect(later.dropped).toBe(true)
  expect(currentUndoStack(runtime)).toEqual([manual, protectedEntry])
})

it('records a small AI edit after twenty manual edits at the native stack limit', async () => {
  open()
  const cell = runtime.univerAPI.getActiveWorkbook()!.getActiveSheet().getRange('A1')
  for (let i = 0; i < 20; i++) cell.setValue(i)
  const receipt = ai(() => cell.setValue('latest'))
  expect(receipt.dropped).toBe(false)
  expect(matchesAiUndoEntries(currentUndoStack(runtime), receipt.entryIds)).toBe(true)
  await runtime.univerAPI.undo()
  expect(cell.getValue()).toBe(19)
  await runtime.univerAPI.redo()
  expect(cell.getValue()).toBe('latest')
})

it('budgets the demo adapter snapshots and releases their stack-owned rollback handles', async () => {
  open()
  const cells = Object.fromEntries(
    Array.from({ length: 13_000 }, (_, i) => [`A${i + 1}`, { value: i }]),
  )
  const snapshot = { revision: 0, sheets: [{ id: 's', name: 'Sheet1', cells }] }
  const retainedCells = adapterHistoryCells(snapshot, snapshot, AI_UNDO_CELL_BUDGET)
  expect(retainedCells).toBe(26_000)
  let value = 0
  for (let i = 1; i <= 12; i++) {
    value = i
    ai(() =>
      pushVisualUndo(
        runtime,
        {
          undo: () => {
            value = i - 1
          },
          redo: () => {
            value = i
          },
        },
        { retainedCells, adapterSnapshot: true },
      ),
    )
  }
  expect(currentUndoStack(runtime)).toHaveLength(3)
  await runtime.univerAPI.undo()
  expect(value).toBe(11)
  await runtime.univerAPI.redo()
  expect(value).toBe(12)
})

it('counts carried AI entries after save, with redo invalidated by the next edit', async () => {
  const service = open()
  for (let i = 0; i < 4; i++)
    ai(() => service.pushUndoRedo(cellItem('file-old', 20_000, String(i))))
  // Move the item between the real service stacks without running worksheet
  // mutations; this test measures what survives a save, including redo.
  service.popUndoToRedo()
  stashUndoCarry(captureUndoCarry(runtime, 'new'))
  loadSnapshotIntoUniver(runtime, empty, 'file-new', 'Workbook')
  consumePendingUndoCarry(runtime, 'file-new')
  expect(service.pitchTopRedoElement()).toBeTruthy()
  for (let i = 0; i < 4; i++)
    ai(() => service.pushUndoRedo(cellItem('file-new', 20_000, String(i))))
  expect(currentUndoStack(runtime)).toHaveLength(5)
  expect(service.pitchTopRedoElement()).toBeFalsy()
})

it('undoes and redoes 72 translated cells one at a time across proposals and ignores the inline editor in chat receipts', async () => {
  const service = open()
  const api = runtime.univerAPI
  const sheet = api.getActiveWorkbook()!.getActiveSheet()
  const size = 72
  const range = sheet.getRange(0, 0, size, 1)
  const original = Array.from({ length: size }, (_, i) => ['Source ' + i])
  range.setValues(original)
  sheet.getRange('B1').setValue('manual before')
  const receipts: string[] = []
  for (let offset = 0; offset < size; offset += 8) {
    const scope = createAiUndoScope(true, undefined, 'file-old', true)
    scope.run(() => {
      service.pushUndoRedo(cellItem('internal-doc', 1, 'internal'))
      for (let i = offset; i < offset + 8; i++) sheet.getRange(i, 0, 1, 1).setValue('번역 ' + i)
    })
    scope.settle()
    expect(scope.entryIds).toHaveLength(8)
    receipts.push(...scope.entryIds)
  }
  expect(matchesAiUndoEntries(currentUndoStack(runtime), receipts)).toBe(true)
  sheet.getRange('B2').setValue('manual after')
  expect(matchesAiUndoEntries(currentUndoStack(runtime), receipts)).toBe(false)
  await api.undo()
  expect(matchesAiUndoEntries(currentUndoStack(runtime), receipts)).toBe(true)
  const verify = (translated: number) =>
    expect(range.getValues()).toEqual(original.map((v, i) => (i < translated ? ['번역 ' + i] : v)))
  verify(size)
  for (let n = size - 1; n >= 0; n--) {
    expect(await api.undo()).toBe(true)
    verify(n)
  }
  expect(sheet.getRange('B1').getValue()).toBe('manual before')
  for (let n = 1; n <= size; n++) {
    expect(await api.redo()).toBe(true)
    verify(n)
  }
  expect(await api.redo()).toBe(true)
  expect(sheet.getRange('B2').getValue()).toBe('manual after')
})

it('keeps a demo adapter change together with its translated grid cell', async () => {
  open()
  const api = runtime.univerAPI
  const sheet = api.getActiveWorkbook()!.getActiveSheet()
  const mirrors = ['a', 'b']
  sheet.getRange('A1:A2').setValues([['a'], ['b']])
  const scope = createAiUndoScope(true, undefined, 'file-old', true)
  for (let i = 0; i < 2; i++)
    scope.cell(() => {
      const old = mirrors[i]!
      const next = 'translation ' + i
      mirrors[i] = next
      sheet.getRange(i, 0, 1, 1).setValue(next)
      pushVisualUndo(
        runtime,
        {
          undo: () => {
            mirrors[i] = old
          },
          redo: () => {
            mirrors[i] = next
          },
        },
        { retainedCells: 2, adapterSnapshot: true },
      )
    })
  scope.settle()
  expect(scope.entryIds).toHaveLength(2)
  expect(await api.undo()).toBe(true)
  expect(sheet.getRange('A1:A2').getValues().flat()).toEqual(['translation 0', 'b'])
  expect(mirrors).toEqual(['translation 0', 'b'])
  expect(await api.redo()).toBe(true)
  expect(mirrors).toEqual(['translation 0', 'translation 1'])
})
