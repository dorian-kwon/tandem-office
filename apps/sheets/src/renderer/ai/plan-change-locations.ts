import { parseAddress, type RangeBounds } from '@genoffice/xlsx-gateway/domain/cell-address'
import { boundsToA1 } from './selection-scope'
import { mergeChangeLocations, type AiChangeLocation } from '@genoffice/agent-core'
import type { ChangePlan } from '@genoffice/xlsx-gateway/domain/workbook.types'

export function planChangeLocations(
  plan: ChangePlan,
  nameOf: (id: string) => string | undefined,
): AiChangeLocation[] {
  function* places(): Generator<AiChangeLocation> {
    const cell = (id: string, range: string): AiChangeLocation => ({
      kind: 'cell',
      id,
      sheet: nameOf(id) ?? id,
      range,
    })
    for (const rename of plan.sheetRenames) yield cell(rename.sheetId, 'A1')
    for (const change of plan.structuralChanges) {
      const op = change.op
      if ('sheetId' in op && typeof op.sheetId === 'string') {
        const range =
          'target' in op && typeof op.target === 'string'
            ? op.target
            : 'range' in op && typeof op.range === 'string'
              ? op.range
              : null
        if (range) yield cell(op.sheetId, range)
      }
    }
    for (const change of plan.formatChanges) yield cell(change.sheetId, change.range)
    if (plan.cellChanges.length <= 16) {
      for (const change of plan.cellChanges) yield cell(change.sheetId, change.address)
      return
    }
    const bySheet = new Map<string, RangeBounds>()
    for (const change of plan.cellChanges) {
      const { row, column } = parseAddress(change.address)
      const bounds = bySheet.get(change.sheetId)
      bySheet.set(
        change.sheetId,
        bounds
          ? {
              startRow: Math.min(bounds.startRow, row),
              endRow: Math.max(bounds.endRow, row),
              startColumn: Math.min(bounds.startColumn, column),
              endColumn: Math.max(bounds.endColumn, column),
            }
          : { startRow: row, endRow: row, startColumn: column, endColumn: column },
      )
    }
    for (const [id, bounds] of bySheet) yield cell(id, boundsToA1(bounds))
  }
  return mergeChangeLocations(undefined, places())
}
