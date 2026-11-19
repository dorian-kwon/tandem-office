import { describe, expect, it, vi } from 'vitest'
import { printDoc } from '../src/renderer/file-actions'
import { tableModelToPmNode, type PmNode } from '../src/renderer/editor/convert'
import {
  PHASED_CONTENT_SETTLED_EVENT,
  PHASE1_BLOCKS,
  PHASE_CHUNK_BLOCKS,
  PHASED_MIN_BLOCKS,
  cancelPhasedContent,
  isPhasedContentPending,
  notePhasedChatInput,
  notePhasedWheel,
  phasedReadAheadDelay,
  phasedScrollEnd,
  setContentPhased,
  waitForFullContent,
  type PhasedContentHost,
} from '../src/renderer/phased-content'

const docOf = (blocks: number): PmNode => ({
  type: 'doc',
  content: Array.from({ length: blocks }, (_, i) => ({
    type: 'docParagraph',
    attrs: { docxIndex: i },
  })),
})

/** host that records events; appends mark dirty like the editor's onUpdate does */
function makeHost(destroyed = false) {
  const state = {
    mounted: [] as PmNode[],
    events: [] as string[],
    dirty: false,
    loading: false,
  }
  const host: PhasedContentHost = {
    setContent: (d) => {
      state.mounted = [...(d.content ?? [])]
      state.events.push(`set:${state.mounted.length}`)
    },
    appendNodes: (nodes) => {
      state.mounted.push(...nodes)
      state.dirty = true
      state.events.push(`append:${nodes.length}`)
    },
    blockCount: () => state.mounted.length,
    isDestroyed: () => destroyed,
    resetHistory: () => state.events.push('resetHistory'),
    setLoading: (v) => {
      state.loading = v
      state.events.push(`loading:${v}`)
    },
    getDirty: () => state.dirty,
    setDirty: (v) => {
      state.dirty = v
    },
  }
  return { host, state }
}

/** scheduler the test drains manually, one chunk per drain() call */
function makeScheduler() {
  const queue: Array<() => void> = []
  return {
    schedule: (cb: () => void) => queue.push(cb),
    drain: () => queue.shift()?.(),
    pending: () => queue.length,
  }
}

describe('setContentPhased', () => {
  it('mounts small documents in one pass without the loading flag', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(state.events).toEqual([`set:${PHASED_MIN_BLOCKS}`])
    expect(s.pending()).toBe(0)
  })

  it('streams a large document in chunks and lands the full content', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2 + 7
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    expect(state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(state.loading).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    // every block landed exactly once, in order
    expect(state.mounted.map((n) => n.attrs?.docxIndex)).toEqual(
      Array.from({ length: blocks }, (_, i) => i),
    )
    expect(state.loading).toBe(false)
    expect(state.events).toContain('resetHistory')
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('defers read-ahead during a wheel gesture and resumes after it or on demand', async () => {
    vi.useFakeTimers()
    try {
      const scroller = document.createElement('main')
      Object.defineProperties(scroller, {
        clientHeight: { value: 400 },
        scrollHeight: { value: 2400 },
      })
      const s = makeScheduler()
      const { host, state } = makeHost()
      setContentPhased(host, docOf(500), s.schedule)
      scroller.scrollTop = 300
      notePhasedWheel(scroller, 100)
      s.drain()
      expect(state.mounted).toHaveLength(PHASE1_BLOCKS)
      vi.advanceTimersByTime(500)
      expect(state.mounted.length).toBeGreaterThan(PHASE1_BLOCKS)
      notePhasedWheel(scroller, 100)
      scroller.scrollTop = 1900
      expect(phasedReadAheadDelay()).toBe(0) // the next screen needs the tail
      scroller.scrollTop = 300
      expect(phasedReadAheadDelay()).toBeGreaterThan(0)
      vi.advanceTimersByTime(500)
      expect(phasedReadAheadDelay()).toBe(0)
      notePhasedChatInput()
      expect(phasedReadAheadDelay()).toBeGreaterThan(0)
      const complete = waitForFullContent()
      notePhasedChatInput()
      expect(phasedReadAheadDelay()).toBe(0)
      while (s.pending()) s.drain()
      await expect(complete).resolves.toBe(true)
      // Opening the dock after loading also queues width-dependent page passes.
      notePhasedChatInput()
      expect(phasedReadAheadDelay()).toBeGreaterThan(0)
      vi.advanceTimersByTime(500)
      expect(phasedReadAheadDelay()).toBe(0)
      notePhasedChatInput()
      await waitForFullContent() // an explicit send, save or print can proceed
      expect(phasedReadAheadDelay()).toBe(0)
      setContentPhased(makeHost().host, docOf(1), s.schedule)
      notePhasedChatInput()
      expect(phasedReadAheadDelay()).toBe(0)
    } finally {
      cancelPhasedContent()
      vi.useRealTimers()
    }
  })

  it('opens print preview for the whole document when chat typing has deferred layout', async () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    const dialogs: number[] = []
    const ctx = {
      doc: { fileName: 'report.docx' },
      printAutoOpenedPreviewRef: { current: false },
      setShowPagePreview() {},
      setShowPrintDialog: () => dialogs.push(state.mounted.length),
    } as unknown as Parameters<typeof printDoc>[0]
    setContentPhased(host, docOf(500), s.schedule)
    notePhasedChatInput()
    expect(phasedReadAheadDelay()).toBeGreaterThan(0)
    printDoc(ctx)
    expect(phasedReadAheadDelay()).toBe(0)
    expect(dialogs).toEqual([])
    while (s.pending()) s.drain()
    await Promise.resolve()
    expect(dialogs).toEqual([500])
    notePhasedChatInput()
    expect(phasedReadAheadDelay()).toBeGreaterThan(0)
    printDoc(ctx)
    expect(phasedReadAheadDelay()).toBe(0)
    expect(dialogs).toEqual([500, 500])
  })

  it('keeps an explicit scroll to the end through streaming and its final layout only', () => {
    const scroller = document.createElement('main')
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 1400 },
    })
    const s = makeScheduler()
    setContentPhased(makeHost().host, docOf(500), s.schedule)
    expect(phasedScrollEnd(scroller)).toBeNull() // first screen
    scroller.scrollTop = 999.5
    expect(phasedScrollEnd(scroller)).toBe(scroller) // browser fractional pixels
    scroller.scrollTop = 600
    expect(phasedScrollEnd(scroller)).toBeNull() // scrolled away
    scroller.scrollTop = 1000
    expect(phasedScrollEnd(scroller)).toBe(scroller)
    while (s.pending()) s.drain()
    expect(phasedScrollEnd(scroller)).toBe(scroller) // last pagination follows the last append
    expect(phasedScrollEnd(scroller)).toBeNull() // subsequent typing and layout are independent
    setContentPhased(makeHost().host, docOf(1), s.schedule)
    expect(phasedScrollEnd(scroller)).toBeNull()
  })

  it('counts nested table content while streaming whole blocks and preserving the save gate', async () => {
    const para = { type: 'docParagraph' }
    const inner = { rows: Array.from({ length: 400 }, () => [{ paras: ['x'] }]) }
    const heavy = tableModelToPmNode({
      rows: [
        [{ paras: [''], nestedTables: [{ rows: [[{ paras: [''], nestedTables: [inner] }]] }] }],
      ],
    })
    const content = [para, heavy, heavy, para]
    const s = makeScheduler()
    const { host, state } = makeHost()
    setContentPhased(host, { type: 'doc', content }, s.schedule)
    expect(state.mounted).toEqual([para])
    const complete = waitForFullContent()
    expect(isPhasedContentPending()).toBe(true)
    s.drain()
    expect(state.mounted).toHaveLength(2)
    expect(state.mounted[1]).toBe(heavy)
    while (s.pending()) s.drain()
    await complete
    expect(state.mounted).toEqual(content)
    expect(state.dirty).toBe(false)
  })

  it('streaming is not an edit: the dirty flag survives every chunk', () => {
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 50), s.schedule)
    while (s.pending() > 0) s.drain()
    expect(state.dirty).toBe(false)
  })

  it('cancelPhasedContent drops the pending tail and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const { host, state } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    s.drain() // first chunk lands
    const landed = state.mounted.length
    cancelPhasedContent()
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(landed)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('a second phased mount cancels the first tail', () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 3
    const first = makeHost()
    const s1 = makeScheduler()
    setContentPhased(first.host, docOf(blocks), s1.schedule)
    const second = makeHost()
    const s2 = makeScheduler()
    setContentPhased(second.host, docOf(blocks), s2.schedule)
    while (s1.pending() > 0) s1.drain()
    while (s2.pending() > 0) s2.drain()
    // the first document keeps only its phase-1 mount; the second is complete
    expect(first.state.mounted.length).toBe(PHASE1_BLOCKS)
    expect(second.state.mounted.length).toBe(blocks)
    expect(first.state.loading).toBe(false)
    expect(second.state.loading).toBe(false)
  })

  it('a rejected chunk falls back to the one-pass mount and releases the save gate', async () => {
    const blocks = PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2
    const { host, state } = makeHost()
    const { appendNodes, setContent } = host
    let appends = 0
    host.appendNodes = (nodes) => {
      if (++appends === 2) throw new Error('schema refused')
      appendNodes(nodes)
    }
    host.setContent = (d) => {
      setContent(d)
      state.dirty = true
    }
    const s = makeScheduler()
    setContentPhased(host, docOf(blocks), s.schedule)
    state.dirty = false
    while (s.pending() > 0) s.drain()
    expect(state.mounted.length).toBe(blocks)
    expect(state.events.at(-3)).toBe(`append:${PHASE_CHUNK_BLOCKS}`)
    // the remount is not an edit either
    expect(state.dirty).toBe(false)
    expect(state.loading).toBe(false)
    await expect(waitForFullContent()).resolves.toBe(true)
  })

  it('does not repeat a chunk when an update listener throws after commit', async () => {
    const { host, state } = makeHost()
    const { appendNodes } = host
    host.appendNodes = (nodes) => {
      appendNodes(nodes)
      throw new Error('listener failed')
    }
    const scheduler = makeScheduler()
    const doc = docOf(PHASED_MIN_BLOCKS + 10)
    setContentPhased(host, doc, scheduler.schedule)
    while (scheduler.pending()) scheduler.drain()
    expect(await waitForFullContent()).toBe(true)
    expect(state.mounted).toEqual(doc.content)
  })

  it('blocks existing and future waiters after a failed recovery until a new file opens', async () => {
    const { host, state } = makeHost()
    host.appendNodes = () => {
      throw new Error('schema refused')
    }
    const scheduler = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 10), scheduler.schedule)
    const waiting = waitForFullContent()
    state.mounted[0] = { type: 'docParagraph', attrs: { edited: true } }
    state.dirty = true
    scheduler.drain()
    expect(await waiting).toBe(false)
    expect(await waitForFullContent()).toBe(false)
    expect(isPhasedContentPending()).toBe(true)
    expect(state.mounted[0]?.attrs?.edited).toBe(true)
    expect(state.dirty).toBe(true)
    expect(scheduler.pending()).toBe(0)
    setContentPhased(host, docOf(1), scheduler.schedule)
    expect(await waitForFullContent()).toBe(true)
    expect(isPhasedContentPending()).toBe(false)
    expect(state.loading).toBe(false)
  })

  it('reports a pending tail only while chunks remain', () => {
    const { host } = makeHost()
    const s = makeScheduler()
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS), s.schedule)
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    expect(isPhasedContentPending()).toBe(true)
    while (s.pending() > 0) s.drain()
    expect(isPhasedContentPending()).toBe(false)
    setContentPhased(host, docOf(PHASED_MIN_BLOCKS + 1), s.schedule)
    cancelPhasedContent()
    expect(isPhasedContentPending()).toBe(false)
  })

  it('announces the settled tail on document, and only then', () => {
    const { host } = makeHost()
    const { schedule, drain, pending } = makeScheduler()
    let announced = 0
    const onSettled = () => announced++
    document.addEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    try {
      setContentPhased(host, docOf(PHASE1_BLOCKS + PHASE_CHUNK_BLOCKS * 2), schedule)
      expect(announced).toBe(0)
      drain()
      expect(announced).toBe(0)
      drain()
      expect(pending()).toBe(0)
      expect(announced).toBe(1)
      // small documents mount in one pass without a tail: nothing to announce
      setContentPhased(host, docOf(3), schedule)
      expect(announced).toBe(1)
    } finally {
      document.removeEventListener(PHASED_CONTENT_SETTLED_EVENT, onSettled)
    }
  })
})
