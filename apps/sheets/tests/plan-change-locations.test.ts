import { expect, it } from 'vitest'
import { planChangeLocations } from '../src/renderer/ai/plan-change-locations'

it('keeps the actual sheet identity for identically named cell addresses and bounds large receipts', () => {
  const cell = (sheetId: string, address: string) => ({
    sheetId,
    address,
    before: { value: '' },
    after: { value: 'edited' },
  })
  const places = planChangeLocations(
    {
      transactionId: 't',
      baseRevision: 0,
      structuralChanges: [],
      sheetRenames: [],
      formatChanges: [],
      warnings: [],
      cellChanges: [
        cell('one', 'B4'),
        cell('two', 'B4'),
        ...Array.from({ length: 50 }, (_, i) => cell('one', 'C' + (i + 1))),
      ],
    },
    (id) => id + ' name',
  )
  expect(places).toEqual([
    { kind: 'cell', id: 'one', sheet: 'one name', range: 'B1:C50' },
    { kind: 'cell', id: 'two', sheet: 'two name', range: 'B4' },
  ])
})
