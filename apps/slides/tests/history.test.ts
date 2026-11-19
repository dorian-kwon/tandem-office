import { describe, expect, it, vi } from 'vitest'
import {
  addPicture,
  createBlankPptx,
  openPptx,
  replacePictureBytes,
  type PictureElement,
} from '@genoffice/pptx-engine'
import type { Session } from '../src/main/session-state'
import {
  beginHistoryBatch,
  carryHistoryForReplacement,
  endHistoryBatch,
  pushHistory,
  withoutAiUndo,
  runAiHistoryRequest,
  withRecordedAiUndo,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  takeSnapshot,
} from '../src/main/session-state'

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
}))
vi.mock('../src/main/fonts', () => ({
  createSystemFontMetrics: () => ({}),
}))

function sessionWith(value: string): Session {
  return {
    path: '',
    fitWidthPx: 1280,
    undoStack: [],
    redoStack: [],
    opened: {
      deck: {
        slides: [{ value }],
        size: { cx: 1, cy: 1 },
      },
      archive: { entries: new Map([['deck', new Uint8Array([value.length])]]) },
    },
  } as unknown as Session
}

function valueOf(session: Session): string {
  return (session.opened.deck.slides[0] as unknown as { value: string }).value
}

function setValue(session: Session, value: string): void {
  ;(session.opened.deck.slides[0] as unknown as { value: string }).value = value
}

describe('Slides main-process history batching', () => {
  it('collapses several edits into one pre-run snapshot', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'first')
    pushHistory(session)
    setValue(session, 'second')
    endHistoryBatch(session)

    expect(session.undoStack).toHaveLength(1)
    restoreSnapshot(session, session.undoStack[0]!)
    expect(valueOf(session)).toBe('before')
  })

  it('keeps the 49 preceding steps when a 60-edit run starts at the 50-step cap', () => {
    const session = sessionWith('start')
    for (let i = 0; i < 50; i++) {
      pushHistory(session)
      setValue(session, `human ${i}`)
    }
    const previous = session.undoStack.slice(1)
    beginHistoryBatch(session, { aiRun: true })
    withRecordedAiUndo(() => {
      for (let i = 0; i < 60; i++) {
        pushHistory(session)
        setValue(session, `AI ${i}`)
      }
    })
    const point = endHistoryBatch(session)
    expect(session.undoStack.slice(0, -1)).toEqual(previous)
    expect(session.undoStack.at(-1)).toBe(point)
    restoreSnapshot(session, session.undoStack.pop()!)
    expect(valueOf(session)).toBe('human 49')
  })

  it('keeps manual edits during an AI run in chronological undo order', () => {
    const session = sessionWith('start')
    const edit = (value: string) => {
      pushHistory(session)
      setValue(session, value)
    }
    beginHistoryBatch(session, { aiRun: true })
    edit('human before')
    withRecordedAiUndo(() => {
      edit('AI first')
      edit('AI second')
    })
    edit('human during')
    withRecordedAiUndo(() => {
      edit('AI third')
      edit('AI fourth')
    })
    expect(endHistoryBatch(session)).toBeNull()
    edit('human after')
    for (const expected of ['AI fourth', 'human during', 'AI second', 'human before', 'start']) {
      restoreSnapshot(session, session.undoStack.pop()!)
      expect(valueOf(session)).toBe(expected)
    }
  })

  it('supports nested tool batching inside an AI-run batch', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'after')
    endHistoryBatch(session)
    expect(session.historyBatch?.depth).toBe(1)
    endHistoryBatch(session)
    expect(session.undoStack).toHaveLength(1)
  })

  it('does not create a history step when every edit is rolled back', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    session.undoStack.pop()
    endHistoryBatch(session)
    expect(session.undoStack).toHaveLength(0)
  })

  it('restores the deck size on undo', () => {
    const session = sessionWith('before')
    pushHistory(session)
    session.opened.deck.size = { cx: 2, cy: 3 }
    setValue(session, 'after')

    restoreSnapshot(session, session.undoStack.pop()!)
    expect(session.opened.deck.size).toEqual({ cx: 1, cy: 1 })
    expect(valueOf(session)).toBe('before')
  })

  it('keeps the old deck snapshot when replacing the full deck', () => {
    const previous = sessionWith('old deck')
    const replacement = sessionWith('new deck')
    carryHistoryForReplacement(previous, replacement)

    expect(replacement.undoStack).toHaveLength(1)
    restoreSnapshot(replacement, replacement.undoStack.pop()!)
    expect(valueOf(replacement)).toBe('old deck')
  })

  it('returns the pre-run snapshot from the outermost batch end with edits', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'after')
    expect(endHistoryBatch(session)).toBeNull()
    const before = endHistoryBatch(session)
    expect(before).not.toBeNull()
    expect((before!.slides[0] as unknown as { value: string }).value).toBe('before')

    const emptyRun = sessionWith('untouched')
    beginHistoryBatch(emptyRun)
    expect(endHistoryBatch(emptyRun)).toBeNull()
  })

  it('rolls back to a registered AI snapshot and makes the rollback undoable', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    const before = endHistoryBatch(session)!
    const id = registerAiSnapshot(session, before)
    expect(session.aiSnapshots!.get(id)).toBe(before)
    expect(session.undoStack.at(-1)).toBe(before)

    expect(restoreAiSnapshot(session, id)).toBe(true)
    expect(valueOf(session)).toBe('before')
    expect(restoreAiSnapshot(session, id)).toBe(false) // consumed

    restoreSnapshot(session, session.undoStack.pop()!) // ⌘Z returns to the pre-rollback state
    expect(valueOf(session)).toBe('ai edited')
  })

  it('detaches rollback points supplied from outside the undo stack', () => {
    const session = sessionWith('before')
    const external = takeSnapshot(session)
    const id = registerAiSnapshot(session, external)
    expect(session.aiSnapshots!.get(id)).not.toBe(external)
    expect(session.aiSnapshots!.get(id)!.slides).not.toBe(external.slides)
  })

  it('keeps the preceding uninterrupted turn available after a panel rewind', async () => {
    const session = sessionWith('start')
    const turn = async (value: string) => {
      beginHistoryBatch(session, { aiRun: true })
      await runAiHistoryRequest(true, () => {
        pushHistory(session)
        setValue(session, value)
      })
      return registerAiSnapshot(session, endHistoryBatch(session)!)
    }
    const first = await turn('first')
    const second = await turn('second')
    expect(restoreAiSnapshot(session, second)).toBe(true)
    expect(valueOf(session)).toBe('first')
    expect(restoreAiSnapshot(session, first)).toBe(true)
    expect(valueOf(session)).toBe('start')
  })

  it('rejects old panel rollbacks after keyboard undo', () => {
    const session = sessionWith('before')
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    const id = registerAiSnapshot(session, endHistoryBatch(session)!)

    restoreSnapshot(session, session.undoStack.pop()!) // undo hands the stack snapshot to the live deck
    setValue(session, 'mutated after undo')
    expect(restoreAiSnapshot(session, id)).toBe(false)
    expect(valueOf(session)).toBe('mutated after undo')
  })

  it('undo restores the archive-only dirty flag with the deck', () => {
    const session = sessionWith('before')
    pushHistory(session)
    setValue(session, 'notes edited')
    session.metaDirty = true

    session.redoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.undoStack.pop()!)
    expect(session.metaDirty).toBe(false)

    restoreSnapshot(session, session.redoStack.pop()!)
    expect(session.metaDirty).toBe(true)
  })

  it('undo → edit → redo replays the state that was undone, not a mutated copy', () => {
    const session = sessionWith('before')
    pushHistory(session)
    setValue(session, 'edited')

    // ⌘Z
    session.redoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.undoStack.pop()!)
    expect(valueOf(session)).toBe('before')

    // typing after the undo must not rewrite the redo snapshot in place
    setValue(session, 'typed after undo')
    restoreSnapshot(session, session.redoStack.pop()!)
    expect(valueOf(session)).toBe('edited')
  })

  it('a batch left open by a crashed tool path is collapsed so undo still works', () => {
    const session = sessionWith('before')
    // run begins a batch, a tool nests another, then the tool path dies without ending either
    beginHistoryBatch(session)
    pushHistory(session)
    setValue(session, 'ai edited')
    beginHistoryBatch(session)
    expect(session.historyBatch).toBeDefined()

    settleStaleHistoryBatch(session)
    expect(session.historyBatch).toBeUndefined()
    expect(session.undoStack.length).toBe(1)

    restoreSnapshot(session, session.undoStack.pop()!)
    expect(valueOf(session)).toBe('before')
  })

  it('undo and redo restore resource bytes and relationships pruned by picture replacement', async () => {
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwV2AAAAAElFTkSuQmCC',
        'base64',
      ),
    )
    const gif = new Uint8Array(
      Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
    )
    const opened = await openPptx(await createBlankPptx())
    const slide = opened.deck.slides[0]!
    const picture = addPicture(opened, slide, {
      bytes: png,
      ext: 'png',
      offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
    })!
    const session: Session = {
      path: '',
      opened,
      fitWidthPx: 1280,
      undoStack: [],
      redoStack: [],
    }
    const oldMedia = picture.mediaRef
    const slash = slide.path.lastIndexOf('/')
    const relsPath = `${slide.path.slice(0, slash)}/_rels/${slide.path.slice(slash + 1)}.rels`
    const oldRels = opened.archive.readText(relsPath)!

    // The IPC mutation path snapshots first, then replacement prunes the old
    // relationship/media as soon as the element points at the new bytes.
    pushHistory(session)
    expect(replacePictureBytes(opened, slide, picture.id, gif, 'gif')).toBe(true)
    const newMedia = picture.mediaRef
    const newRels = opened.archive.readText(relsPath)!
    expect(opened.archive.entries.has(oldMedia)).toBe(false)
    expect(opened.archive.readBytes(newMedia)).toEqual(gif)

    // Production undo stores the cleaned state for redo, then restores the
    // pre-mutation snapshot.
    session.redoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.undoStack.pop()!)
    expect(session.opened.archive.readBytes(oldMedia)).toEqual(png)
    expect(session.opened.archive.entries.has(newMedia)).toBe(false)
    expect(session.opened.archive.readText(relsPath)).toBe(oldRels)
    expect(
      (
        session.opened.deck.slides[0]!.elements.find(
          (element) => element.type === 'picture',
        ) as PictureElement
      ).mediaRef,
    ).toBe(oldMedia)

    // Production redo snapshots the restored state and reapplies the cleaned
    // archive/model snapshot.
    session.undoStack.push(takeSnapshot(session))
    restoreSnapshot(session, session.redoStack.pop()!)
    expect(session.opened.archive.entries.has(oldMedia)).toBe(false)
    expect(session.opened.archive.readBytes(newMedia)).toEqual(gif)
    expect(session.opened.archive.readText(relsPath)).toBe(newRels)
    expect(
      (
        session.opened.deck.slides[0]!.elements.find(
          (element) => element.type === 'picture',
        ) as PictureElement
      ).mediaRef,
    ).toBe(newMedia)
  })
})

describe('AI undo history switched off', () => {
  it('does not record AI requests, even across async work, and preserves manual history', async () => {
    const session = sessionWith('before')
    pushHistory(session)
    setValue(session, 'human before')
    const human = session.undoStack[0]
    beginHistoryBatch(session, { dropUndo: true })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = withoutAiUndo(async () => {
      await barrier
      for (let i = 0; i < 60; i++) {
        pushHistory(session)
        setValue(session, `AI ${i}`)
      }
    })
    pushHistory(session)
    setValue(session, 'human during')
    release()
    await pending
    expect(endHistoryBatch(session)).toBeNull()
    expect(session.undoStack).toHaveLength(2)
    expect(session.undoStack[0]).toBe(human)
    expect(session.redoStack).toHaveLength(0)
  })

  it('keeps only the QC rollback point and can restore it without adding undo', async () => {
    const session = sessionWith('before')
    beginHistoryBatch(session, { dropUndo: true, keepRollback: true })
    await withoutAiUndo(() => {
      pushHistory(session)
      setValue(session, 'QC')
    })
    const before = endHistoryBatch(session)
    expect(before).not.toBeNull()
    const id = registerAiSnapshot(session, before!)
    expect(restoreAiSnapshot(session, id, { recordUndo: false })).toBe(true)
    expect(valueOf(session)).toBe('before')
    expect(session.undoStack).toHaveLength(0)
  })

  it('refuses both stale panel and internal QC snapshots after manual edits', async () => {
    const session = sessionWith('before')
    beginHistoryBatch(session, { aiRun: true })
    withRecordedAiUndo(() => {
      pushHistory(session)
      setValue(session, 'AI')
    })
    const id = registerAiSnapshot(session, endHistoryBatch(session)!)
    pushHistory(session)
    setValue(session, 'human')
    expect(restoreAiSnapshot(session, id)).toBe(false)
    beginHistoryBatch(session, { dropUndo: true, keepRollback: true })
    await withoutAiUndo(() => {
      pushHistory(session)
      setValue(session, 'QC')
    })
    pushHistory(session)
    setValue(session, 'human during QC')
    expect(endHistoryBatch(session)).toBeNull()
    expect(valueOf(session)).toBe('human during QC')
  })

  it.each([true, false])(
    'retains redo when a request rolls back all changes (record=%s)',
    async (record) => {
      const session = sessionWith('before')
      const redo = takeSnapshot(session)
      session.redoStack.push(redo)
      beginHistoryBatch(session, {
        aiRun: true,
        ...(!record && { dropUndo: true, keepRollback: true }),
      })
      await runAiHistoryRequest(record, () => {
        pushHistory(session)
        session.undoStack.pop() // normal failure/no-op handler
      })
      expect(endHistoryBatch(session)).toBeNull()
      expect(session.redoStack).toEqual([redo])
    },
  )

  it('releases temporary snapshots after errors and preserves a replacement deck history', async () => {
    const previous = sessionWith('old')
    pushHistory(previous)
    const replacement = sessionWith('new')
    await withoutAiUndo(() => carryHistoryForReplacement(previous, replacement))
    expect(replacement.undoStack).toHaveLength(1)
    await expect(
      withoutAiUndo(() => {
        pushHistory(replacement)
        throw new Error('failed')
      }),
    ).rejects.toThrow('failed')
    expect(replacement.undoStack).toHaveLength(1)
  })
})
