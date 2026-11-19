import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'

import { beginUndoBatch, shouldDropUndoBatch } from '../src/renderer/op-executor'
import { aiBulkUndoGate, aiUndoHistory, setAiEditUndoHistory } from '../src/renderer/univer-state'

const runtime = {
  univerAPI: { getActiveWorkbook: () => null },
} as unknown as Parameters<typeof beginUndoBatch>[0]

it('records AI edits with the app default', () => {
  expect(aiUndoHistory.enabled).toBe(true)
  expect(shouldDropUndoBatch({ aiEdit: true })).toBe(false)
})

describe('AI edit undo history setting', () => {
  beforeEach(() => {
    aiBulkUndoGate.active = false
    aiBulkUndoGate.dropAll = false
    aiBulkUndoGate.dropped = false
    setAiEditUndoHistory(true)
  })

  it('drops an AI apply from the start while the setting is off', () => {
    setAiEditUndoHistory(false)
    expect(shouldDropUndoBatch({ aiEdit: true })).toBe(true)
  })

  it('keeps an AI apply when the setting is on', () => {
    setAiEditUndoHistory(true)
    expect(shouldDropUndoBatch({ aiEdit: true })).toBe(false)
  })

  it('never drops a ribbon or dialog apply, whatever the setting says', () => {
    setAiEditUndoHistory(false)
    expect(shouldDropUndoBatch({ userFacing: true })).toBe(false)
    expect(shouldDropUndoBatch({})).toBe(false)
    setAiEditUndoHistory(true)
    expect(shouldDropUndoBatch({ userFacing: true })).toBe(false)
    expect(shouldDropUndoBatch({})).toBe(false)
  })

  it('beginUndoBatch keeps the existing opt-in budget without suppressing all history', () => {
    const first = beginUndoBatch(runtime)
    expect(aiBulkUndoGate.active).toBe(true)
    expect(aiBulkUndoGate.dropAll).toBe(false)
    first.settle()
    expect(aiBulkUndoGate.active).toBe(false)

    const second = beginUndoBatch(runtime)
    expect(aiBulkUndoGate.dropAll).toBe(false)
    expect(aiBulkUndoGate.dropped).toBe(false)
    second.settle()
  })
})

describe('AI source wiring in App.tsx', () => {
  const app = readFileSync(
    fileURLToPath(new URL('../src/renderer/App.tsx', import.meta.url)),
    'utf8',
  )

  it('marks the in-app AI apply and the MCP bridge as AI edits and forwards translation mode', () => {
    const lazyApply = app.slice(app.indexOf('async function handleLazyApply'))
    expect(lazyApply.slice(0, lazyApply.indexOf('function runUiOps'))).toMatch(
      /aiEdit:\s*true,\s*translation,/,
    )
    expect(app).toMatch(/await runUiOps\(ops,\s*undefined,\s*true,\s*translation\)/)
  })

  it('keeps ribbon and dialog edits (runUiOps default) out of the AI path', () => {
    const runUiOps = app.slice(app.indexOf('function runUiOps'))
    expect(runUiOps.slice(0, runUiOps.indexOf('): Promise<ApplyOutcome>'))).toMatch(
      /aiEdit\s*=\s*false,\s*translation\s*=\s*false/,
    )
    expect(runUiOps).toMatch(/\.\.\.\(aiEdit \? \{ aiEdit: true, translation \} : \{\}\)/)
  })
})
