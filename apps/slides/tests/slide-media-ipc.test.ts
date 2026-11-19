import { tmpdir } from 'node:os'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: never[]) => unknown>()
const broadcasts: Array<{ id: number; channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'slides-test',
    getVersion: () => '0',
    whenReady: () => Promise.resolve(),
  },
  dialog: {},
  clipboard: { writeBuffer: () => {} },
  ipcMain: {
    handle: (channel: string, fn: (...args: never[]) => unknown) => handlers.set(channel, fn),
    on: () => {},
    removeHandler: () => {},
  },
  BrowserWindow: class {},
  webContents: {
    getAllWebContents: () => [],
    fromId: (id: number) => ({
      send: (channel: string, payload: unknown) => broadcasts.push({ id, channel, payload }),
    }),
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  session: {
    defaultSession: { protocol: { handle: () => {} }, setDisplayMediaRequestHandler: () => {} },
  },
  nativeImage: {},
  shell: {},
  desktopCapturer: { getSources: async () => [] },
  WebContentsView: class {},
}))
// The shaping chain loads a harfbuzz wasm that cannot resolve in the unit-test env;
// none of the handlers under test measure text.
vi.mock('../src/main/shaped-metrics', () => ({
  shapedMetricsReady: async () => {},
  refineComplexWidths: async () => {},
  complexScriptOf: () => null,
  initShapedMetrics: () => {},
  gtMeasure: (t: string) => ({ width: t.length * 8 }),
  shapedFamily: () => null,
  shapedMeasure: () => ({ width: 0 }),
}))

import { serialize } from 'node:v8'
import { elementDurableId } from '@genoffice/pptx-engine/identity'
import {
  addPicture,
  addElement,
  addTable,
  createBlankPptx,
  getSlideNotes,
  parseMasterPart,
  duplicateSlide,
  openPptx,
  savePptx,
  replacePictureBytes,
  type PictureElement,
  type TextElement,
} from '@genoffice/pptx-engine'
import { registerSlidesIpc } from '../src/main/slides-main'
import {
  buildAllRenderSlides,
  makeMediaResolver,
  rebuildSlide,
  readSlideMedia,
  pruneMediaSources,
  takeSnapshot,
  sessions,
  type Session,
} from '../src/main/session-state'
import { mergeSlideUpdate } from '../src/shared/slide-update'
import type { PasteSlideResult } from '../src/shared/ipc'
import type { PictureRenderNode, RenderSlide } from '@genoffice/pptx-render'

const FIT = 1280
const WC = 1
let session: Session
function call(channel: string, ...args: unknown[]): any {
  return (handlers.get(channel) as (...args: unknown[]) => unknown)({ sender: { id: WC } }, ...args)
}
beforeAll(() => registerSlidesIpc())
beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve))
  broadcasts.length = 0
  sessions.clear()
  session = {
    path: '',
    fitWidthPx: FIT,
    undoStack: [],
    redoStack: [],
    opened: await openPptx(await createBlankPptx()),
  }
  sessions.set(WC, session)
})

function addImage(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  // A valid 1px PNG followed by padding models a large embedded image without a fixture.
  bytes.set(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
      'base64',
    ),
  )
  expect(
    addPicture(session.opened, session.opened.deck.slides[0]!, {
      bytes,
      ext: 'png',
      offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
    }),
  ).toBeTruthy()
  expect(duplicateSlide(session.opened, 0)).toBeTruthy()
  return bytes
}

describe('slide media IPC payload', () => {
  it.each(
    ['slides:paste-slide', 'slides:duplicate-slides', 'slides:add-slide'].flatMap((channel) =>
      [1024, 50 * 1024 * 1024].map((size) => [channel, size] as const),
    ),
  )('%s keeps a %i byte image outside the response', (channel, size) => {
    addImage(size)
    call('slides:copy-slides', { slideIndexes: [0] })
    const r = call(channel, { afterIndex: 0, sourceIndex: 0, slideIndexes: [0], fitWidthPx: FIT })
    const payloadBytes = serialize(r).byteLength
    process.stdout.write(`${channel} (${size} byte image): V8 payload ${payloadBytes} bytes\n`)
    expect(JSON.stringify(r).includes('data:image/')).toBe(false)
    expect(payloadBytes).toBeLessThan(32 * 1024)
    expect(r.slides).toHaveLength(1)
    const url = (r.slides[0].nodes[0] as PictureRenderNode).dataUrl!
    expect(url.startsWith('genoffice-slide-media://')).toBe(true)
    expect(readSlideMedia(url)?.body.byteLength).toBe(size)
  })

  it.each([1024, 50 * 1024 * 1024])(
    'inserts and deletes slides with %i byte media without sending the deck',
    async (size) => {
      addImage(size)
      const before = buildAllRenderSlides(session.opened, FIT)
      const added = call('slides:add-blank-slide', {
        sourceIndex: 0,
        before: true,
        fitWidthPx: FIT,
      })
      expect(serialize(added).byteLength).toBeLessThan(32 * 1024)
      let current = mergeSlideUpdate(before, added)
      expect(current.map((s) => s.partPath)).toEqual(added.order)
      expect(current.slice(1)).toEqual(before)
      const deleted = call('slides:delete-slides', { slideIndexes: [0, 2] })
      expect(serialize(deleted).byteLength).toBeLessThan(32 * 1024)
      current = mergeSlideUpdate(current, deleted)
      expect(current.map((s) => s.partPath)).toEqual([before[0]!.partPath])
      expect((call('slides:undo') as RenderSlide[]).map((s) => s.partPath)).toEqual(added.order)
      expect((call('slides:redo') as RenderSlide[]).map((s) => s.partPath)).toEqual(deleted.order)
      const saved = await openPptx(await savePptx(session.opened))
      expect(saved.deck.slides.map((s) => s.path)).toEqual(deleted.order)
      const picture = saved.deck.slides[0]!.elements.find(
        (e) => e.type === 'picture',
      ) as PictureElement
      expect(saved.archive.readBytes(picture.mediaRef!)?.byteLength).toBe(size)
    },
  )

  it.each([1024, 50 * 1024 * 1024])(
    'reorders, hides and deletes without transferring %i byte media',
    async (size) => {
      const bytes = addImage(size)
      duplicateSlide(session.opened, 1)
      let current = buildAllRenderSlides(session.opened, FIT)
      const original = current.map((s) => s.partPath)
      for (const [channel, op] of [
        ['slides:move-slide', { fromIndex: 0, toIndex: 2 }],
        ['slides:move-slides', { slideIndexes: [0, 1], insertAt: 3 }],
        ['slides:set-slides-hidden', { slideIndexes: [0, 1], hidden: true }],
        ['slides:delete-slide', 1],
      ] as const) {
        const result = call(channel, op)
        const payloadBytes = serialize(result).byteLength
        process.stdout.write(`${channel} (${size} byte image): V8 payload ${payloadBytes} bytes\n`)
        expect(payloadBytes).toBeLessThan(32 * 1024)
        current = mergeSlideUpdate(current, result)
        expect(current).toEqual(buildAllRenderSlides(session.opened, FIT))
        const undone = call('slides:undo') as RenderSlide[]
        expect(serialize(undone).byteLength).toBeLessThan(32 * 1024)
        const redone = call('slides:redo') as RenderSlide[]
        expect(redone).toEqual(current)
      }
      expect(current.map((s) => s.partPath)).not.toEqual(original)
      const reopened = await openPptx(await savePptx(session.opened))
      expect(reopened.deck.slides.map((s) => s.path)).toEqual(current.map((s) => s.partPath))
      const picture = reopened.deck.slides
        .flatMap((s) => s.elements)
        .find((e) => e.type === 'picture') as PictureElement
      expect(
        Buffer.compare(
          Buffer.from(reopened.archive.readBytes(picture.mediaRef!)!),
          Buffer.from(bytes),
        ),
      ).toBe(0)
    },
  )

  it.each(['slides:paste-slide', 'slides:duplicate-slides'] as const)(
    'preserves untouched package parts after %s and reopening',
    async (channel) => {
      const bytes = addImage(1024)
      const fixture = await savePptx(session.opened)
      session.opened = await openPptx(fixture)
      const JSZip = (await import('jszip')).default
      const original = await JSZip.loadAsync(fixture)
      call('slides:copy-slides', { slideIndexes: [0] })
      const result = call(channel, {
        afterIndex: 0,
        slideIndexes: [0],
        fitWidthPx: FIT,
      }) as PasteSlideResult
      const saved = await savePptx(session.opened)
      const reopened = await openPptx(saved)
      const output = await JSZip.loadAsync(saved)
      // Insertion changes the presentation manifest and its relationships.
      const changed = new Set([
        '[Content_Types].xml',
        'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels',
      ])
      for (const [path, entry] of Object.entries(original.files)) {
        if (entry.dir || changed.has(path)) continue
        expect(output.file(path), path).not.toBeNull()
        expect(await output.file(path)!.async('uint8array'), path).toEqual(
          await entry.async('uint8array'),
        )
      }
      const picture = reopened.deck.slides[result.index]!.elements.find(
        (element) => element.type === 'picture',
      ) as PictureElement
      expect(reopened.archive.readBytes(picture.mediaRef!)).toEqual(bytes)
    },
  )

  it('keeps a paste into a 200-slide deck below 1 MB', () => {
    addImage(1024 * 1024)
    for (let i = 2; i < 200; i++) expect(duplicateSlide(session.opened, 0)).toBeTruthy()
    const before = buildAllRenderSlides(session.opened, FIT)
    call('slides:copy-slides', { slideIndexes: [0] })
    const result = call('slides:paste-slide', { afterIndex: 99, fitWidthPx: FIT })
    const payloadBytes = serialize(result).byteLength
    process.stdout.write(`200-slide paste: V8 payload ${payloadBytes} bytes\n`)
    expect(payloadBytes).toBeLessThan(1024 * 1024)
    expect(mergeSlideUpdate(before, result).map((s) => s.partPath)).toEqual(result.order)
  })

  it.each([1024, 50 * 1024 * 1024])(
    'updates only the background target with %i byte media',
    async (size) => {
      const bytes = addImage(size)
      const before = buildAllRenderSlides(session.opened, FIT)
      const result = await call('slides:edit-background', {
        slideIndex: 0,
        kind: 'solid',
        color: 'FF0000',
        fitWidthPx: FIT,
      })
      expect(serialize(result).byteLength).toBeLessThan(32 * 1024)
      expect(result.slides).toHaveLength(1)
      const updated = mergeSlideUpdate(before, result)
      expect(updated).toEqual(buildAllRenderSlides(session.opened, FIT))
      expect(call('slides:undo')).toEqual(before)
      expect(call('slides:redo')).toEqual(updated)
      const reopened = await openPptx(await savePptx(session.opened))
      const picture = reopened.deck.slides[0]!.elements.find(
        (e) => e.type === 'picture',
      ) as PictureElement
      expect(
        Buffer.compare(
          Buffer.from(reopened.archive.readBytes(picture.mediaRef!)!),
          Buffer.from(bytes),
        ),
      ).toBe(0)
    },
  )

  it.each([1024, 50 * 1024 * 1024])(
    'replaces text without transferring %i byte media',
    async (size) => {
      const bytes = addImage(size)
      addElement(session.opened.deck.slides[0]!, {
        kind: 'textbox',
        offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
        paragraphs: [{ runs: [{ text: 'needle' }] }],
      })
      const before = buildAllRenderSlides(session.opened, FIT)
      const result = call('slides:find-replace', { find: 'needle', replace: 'replacement' })
      expect(result.count).toBe(1)
      expect(result.update.slides).toHaveLength(1)
      expect(serialize(result).byteLength).toBeLessThan(32 * 1024)
      const updated = mergeSlideUpdate(before, result.update)
      expect(updated).toEqual(buildAllRenderSlides(session.opened, FIT))
      expect(call('slides:undo')).toEqual(before)
      expect(call('slides:redo')).toEqual(updated)
      const reopened = await openPptx(await savePptx(session.opened))
      const picture = reopened.deck.slides[0]!.elements.find(
        (e) => e.type === 'picture',
      ) as PictureElement
      expect(
        Buffer.compare(
          Buffer.from(reopened.archive.readBytes(picture.mediaRef!)!),
          Buffer.from(bytes),
        ),
      ).toBe(0)
    },
  )

  it('keeps multiple large images outside the update and the open result', () => {
    const bytes = addImage(8 * 1024 * 1024)
    for (let i = 1; i < 6; i++) {
      addPicture(session.opened, session.opened.deck.slides[0]!, {
        bytes,
        ext: 'png',
        offset: { x: i * 914400, y: 0, cx: 914400, cy: 914400 },
      })
    }
    expect(serialize(buildAllRenderSlides(session.opened, FIT)).byteLength).toBeLessThan(32 * 1024)
    call('slides:copy-slides', { slideIndexes: [0] })
    const result = call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT })
    expect(serialize(result).byteLength).toBeLessThan(32 * 1024)
    expect(
      result.slides[0].nodes.filter((n: { type: string }) => n.type === 'picture'),
    ).toHaveLength(6)
  })

  it('sends the same page-local AI batch to the editor and its peer, with one undo step', async () => {
    addImage(1024)
    duplicateSlide(session.opened, 1)
    sessions.set(2, session)
    const before = buildAllRenderSlides(session.opened, FIT)
    const first = session.opened.deck.slides[0]!.path
    const initialNotes = getSlideNotes(session.opened.archive, first)
    const ops = [
      { op: 'setNotes', target: { slide: 0 }, text: 'New notes' },
      { op: 'setHidden', target: { slide: 's_3' }, hidden: true },
      { op: 'setTransition', target: { slide: 2 }, kind: 'fade' },
    ]
    call('slides:history-batch-begin', { aiRun: true })
    const reply = await call('slides:apply-txn:ai-edit', [{ ops, acceptSlideUpdate: true }], true)
    call('slides:history-batch-end')
    expect(reply.applied).toBe(true)
    expect(reply.slides).toBeUndefined()
    expect(reply.update.slides.map((s: RenderSlide) => s.partPath)).toEqual([
      before[0]!.partPath,
      before[2]!.partPath,
    ])
    const expected = buildAllRenderSlides(session.opened, FIT)
    const merged = mergeSlideUpdate(before, reply.update)
    expect(merged).toEqual(expected)
    expect(merged[1]).toBe(before[1])
    expect(getSlideNotes(session.opened.archive, first)).toBe('New notes')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = broadcasts.filter((b) => b.channel === 'slides:deck-changed')
    expect(messages.map((m) => m.id)).toEqual([1, 2])
    for (const message of messages) expect(message.payload).toMatchObject(reply.update)
    expect(session.undoStack).toHaveLength(1)
    expect(call('slides:undo')).toEqual(before)
    expect(getSlideNotes(session.opened.archive, first)).toBe(initialNotes)
    expect(call('slides:redo')).toEqual(expected)
    expect(getSlideNotes(session.opened.archive, first)).toBe('New notes')
  })

  it('keeps full responses for existing callers and batches that change slide structure', async () => {
    addImage(1024)
    const notes = { op: 'setNotes', target: { slide: 0 }, text: 'Speaker notes' }
    const ordinary = call('slides:apply-txn', { ops: [notes] })
    expect(ordinary.update).toBeUndefined()
    expect(ordinary.slides).toEqual(buildAllRenderSlides(session.opened, FIT))
    const mixed = await call(
      'slides:apply-txn:ai-edit',
      [
        {
          ops: [notes, { op: 'deleteSlide', target: { slide: 1 } }],
          acceptSlideUpdate: true,
        },
      ],
      true,
    )
    expect(mixed.applied).toBe(true)
    expect(mixed.update).toBeUndefined()
    expect(mixed.slides).toEqual(buildAllRenderSlides(session.opened, FIT))
  })

  it('rebuilds every page when a local edit addresses inherited master content', async () => {
    addImage(1024)
    const part = 'ppt/slideMasters/slideMaster1.xml'
    const added = call('slides:apply-txn', {
      ops: [
        {
          op: 'addElement',
          target: { part },
          kind: 'rect',
          offset: { x: 0, y: 0, cx: 500000, cy: 500000 },
        },
      ],
    })
    expect(added.applied).toBe(true)
    const el = elementDurableId(parseMasterPart(session.opened.archive, part)!.elements.at(-1)!)
    // A part takes precedence even if the caller also supplies a slide index.
    const r = await call(
      'slides:apply-txn:ai-edit',
      [
        {
          ops: [{ op: 'setFill', target: { part, slide: 0, el }, fill: '#123456' }],
          acceptSlideUpdate: true,
        },
      ],
      true,
    )
    expect(r.failures).toBeUndefined()
    expect(r.applied).toBe(true)
    expect(r.update).toBeUndefined()
    expect(r.slides).toEqual(buildAllRenderSlides(session.opened, FIT))
    expect(r.slides).toHaveLength(2)
  })

  it('broadcasts only new pages to both attached windows and coalesces partial updates', async () => {
    addImage(1024 * 1024)
    sessions.set(2, session)
    const before = buildAllRenderSlides(session.opened, FIT)
    call('slides:copy-slides', { slideIndexes: [0] })
    call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT })
    call('slides:duplicate-slides', { slideIndexes: [0], fitWidthPx: FIT })
    const expected = buildAllRenderSlides(session.opened, FIT)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = broadcasts.filter((b) => b.channel === 'slides:deck-changed')
    expect(messages.map((b) => b.id)).toEqual([1, 2])
    for (const message of messages) {
      const update = message.payload as PasteSlideResult
      expect(update.slides).toHaveLength(2)
      expect(serialize(update).byteLength).toBeLessThan(32 * 1024)
      expect(mergeSlideUpdate(before, update)).toEqual(expected)
    }
  })

  it('resyncs when undo shares a broadcast task with an insertion', async () => {
    addImage(1024)
    sessions.set(2, session)
    call('slides:duplicate-slides', { slideIndexes: [0], fitWidthPx: FIT })
    call('slides:undo')
    const expected = buildAllRenderSlides(session.opened, FIT)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const messages = broadcasts.filter((b) => b.channel === 'slides:deck-changed')
    expect(messages).toHaveLength(2)
    const state = messages[0]!.payload as { slides: RenderSlide[]; order?: string[] }
    expect(state.order).toBeUndefined()
    expect(state.slides).toEqual(expected)
  })

  it('duplicates a noncontiguous selection in order after the last selected page', async () => {
    addImage(1024)
    duplicateSlide(session.opened, 1)
    duplicateSlide(session.opened, 2)
    const before = buildAllRenderSlides(session.opened, FIT)
    const result = call('slides:duplicate-slides', { slideIndexes: [2, 0, 2], fitWidthPx: FIT })
    const current = mergeSlideUpdate(before, result)
    expect(result.index).toBe(3)
    expect(result.slides).toHaveLength(2)
    expect(current.map((s) => s.partPath)).toEqual([
      before[0]!.partPath,
      before[1]!.partPath,
      before[2]!.partPath,
      result.slides[0].partPath,
      result.slides[1].partPath,
      before[3]!.partPath,
    ])
    const saved = await openPptx(await savePptx(session.opened))
    expect(saved.deck.slides).toHaveLength(6)
    expect(saved.deck.slides[3]!.elements.some((e) => e.type === 'picture')).toBe(true)
  })

  it('refreshes shifted slide-number fields and reverses the renumber on picture repaste', () => {
    const bytes = addImage(1024)
    const numbered = session.opened.deck.slides[1]!
    const text = addElement(numbered, {
      kind: 'textbox',
      offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
      paragraphs: [{ runs: [{ text: '2', field: 'slidenum' }] }],
    }) as TextElement
    expect(text).toBeTruthy()
    const before = buildAllRenderSlides(session.opened, FIT)
    call('slides:copy-slides', { slideIndexes: [0], pngs: [Buffer.from(bytes).toString('base64')] })
    const pasted = call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT })
    expect(pasted.slides.map((s: RenderSlide) => s.partPath)).toContain(numbered.path)
    let current = mergeSlideUpdate(before, pasted)
    expect(current[2]).toEqual(rebuildSlide(session, 2))
    expect(current[2]).not.toEqual(before[1])
    const picture = call('slides:repaste-slide', { fitWidthPx: FIT, mode: 'picture' })
    current = mergeSlideUpdate(current, picture)
    expect(current[1]).toEqual(rebuildSlide(session, 1))
    expect(current[1]).toEqual(before[1])
  })

  it.each(['theme', 'source'] as const)(
    'pastes between two pages in %s mode, undo/redoes and saves image bytes',
    async (mode) => {
      const bytes = addImage(1024 * 1024)
      const before = buildAllRenderSlides(session.opened, FIT)
      call('slides:copy-slides', { slideIndexes: [0] })
      const result = call('slides:paste-slide', {
        afterIndex: 0,
        fitWidthPx: FIT,
        mode,
      }) as PasteSlideResult
      const merged = mergeSlideUpdate(before, result)
      expect(result.index).toBe(1)
      expect(result.count).toBe(1)
      expect(merged).toHaveLength(3)
      expect(merged[0]).toBe(before[0])
      expect(merged[2]).toBe(before[1])
      const picture = merged[1]!.nodes.find((n) => n.type === 'picture') as PictureRenderNode
      expect(
        Buffer.compare(Buffer.from(readSlideMedia(picture.dataUrl!)!.body), Buffer.from(bytes)),
      ).toBe(0)
      const undone = call('slides:undo') as RenderSlide[]
      expect(undone.map((s) => s.partPath)).toEqual(before.map((s) => s.partPath))
      const redone = call('slides:redo') as RenderSlide[]
      expect(redone.map((s) => s.partPath)).toEqual(merged.map((s) => s.partPath))
      expect(serialize(redone).byteLength).toBeLessThan(32 * 1024)
      const saved = await openPptx(await savePptx(session.opened))
      expect(saved.deck.slides.map((s) => s.path)).toEqual(result.order)
      const savedPicture = saved.deck.slides[1]!.elements.find(
        (el) => el.type === 'picture',
      ) as PictureElement
      expect(
        Buffer.compare(
          Buffer.from(saved.archive.readBytes(savedPicture.mediaRef!)!),
          Buffer.from(bytes),
        ),
      ).toBe(0)
    },
  )

  it('repastes from slides to picture and back without leaving a stale inserted page', () => {
    const bytes = addImage(1024)
    const before = buildAllRenderSlides(session.opened, FIT)
    call('slides:copy-slides', { slideIndexes: [0], pngs: [Buffer.from(bytes).toString('base64')] })
    const pasted = call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT, mode: 'theme' })
    let current = mergeSlideUpdate(before, pasted)
    const picture = call('slides:repaste-slide', { fitWidthPx: FIT, mode: 'picture' })
    current = mergeSlideUpdate(current, picture)
    expect(picture.count).toBe(0)
    expect(current).toHaveLength(2)
    expect(current[0]!.nodes.filter((n) => n.type === 'picture')).toHaveLength(2)
    const source = call('slides:repaste-slide', { fitWidthPx: FIT, mode: 'source' })
    current = mergeSlideUpdate(current, source)
    expect(current).toHaveLength(3)
    // Restoring the snapshot also removes the picture pasted on the anchor.
    expect(current[0]!.nodes.filter((n) => n.type === 'picture')).toHaveLength(1)
    expect(session.undoStack).toHaveLength(1)
  })

  it('prunes media absent from the archive and history while retaining rollback bytes', () => {
    addImage(1024)
    const slide = session.opened.deck.slides[0]!
    const pic = slide.elements.find((el) => el.type === 'picture') as PictureElement
    const original = makeMediaResolver(session.opened, slide.path)(pic.mediaRef!)!
    pruneMediaSources(session)
    expect(readSlideMedia(original)).not.toBeNull()
    const oldPath = pic.mediaRef!
    session.undoStack.push(takeSnapshot(session))
    const replacement = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
    expect(replacePictureBytes(session.opened, slide, pic.id, replacement, 'png')).toBe(true)
    const updated = makeMediaResolver(session.opened, slide.path)(pic.mediaRef!)!
    session.opened.archive.entries.delete(oldPath)
    pruneMediaSources(session)
    expect(readSlideMedia(original)).not.toBeNull()
    expect(readSlideMedia(updated)).not.toBeNull()
    session.undoStack = []
    pruneMediaSources(session)
    expect(readSlideMedia(original)).toBeNull()
    expect(readSlideMedia(updated)).not.toBeNull()
  })

  it('gives a replaced image a new URL and restores the original URL on undo', () => {
    addImage(1024)
    const slide = session.opened.deck.slides[0]!
    const pic = slide.elements.find((el) => el.type === 'picture') as PictureElement
    const original = makeMediaResolver(session.opened, slide.path)(pic.mediaRef!)!
    call('slides:copy-slides', { slideIndexes: [0] })
    call('slides:paste-slide', { afterIndex: 0, fitWidthPx: FIT })
    const replacement = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
    expect(replacePictureBytes(session.opened, slide, pic.id, replacement, 'png')).toBe(true)
    const updated = makeMediaResolver(session.opened, slide.path)(pic.mediaRef!)!
    expect(updated).not.toBe(original)
    expect(readSlideMedia(updated)?.body.byteLength).toBe(replacement.length)
    call('slides:undo')
    const restored = session.opened.deck.slides[0]!.elements.find(
      (el) => el.type === 'picture',
    ) as PictureElement
    expect(makeMediaResolver(session.opened, slide.path)(restored.mediaRef!)).toBe(original)
    expect(readSlideMedia('genoffice-slide-media://archive/unknown')).toBeNull()
  })
})

it('keeps 65 translated text/notes steps across two transactions and a separate manual edit', async () => {
  const slide = session.opened.deck.slides[0]!
  const ids = Array.from(
    { length: 64 },
    (_, i) =>
      addElement(slide, {
        kind: 'textbox',
        offset: { x: 0, y: 0, cx: 914400, cy: 914400 },
        paragraphs: [{ runs: [{ text: 'Source ' + i }] }],
      })!.id,
  )
  const values = () =>
    session.opened.deck.slides[0]!.elements.filter((e) => ids.includes(e.id)).map(
      (e) => (e as TextElement).text!.paragraphs[0]!.runs[0]!.text,
    )
  const ops = [
    ...ids.map((id, i) => ({
      op: 'setText',
      target: { slide: 0, el: id },
      paragraphs: [{ runs: [{ text: '번역 ' + i }] }],
    })),
    { op: 'setNotes', target: { slide: 0 }, text: '현장 노트' },
  ]
  const firstNotes = getSlideNotes(session.opened.archive, slide.path)
  const apply = (ops: unknown[]) =>
    call('slides:apply-txn:ai-edit', [{ ops, translation: true, acceptSlideUpdate: true }], true)
  call('slides:history-batch-begin', { aiRun: true })
  expect((await apply(ops.slice(0, 36))).applied).toBe(true)
  expect((await apply(ops.slice(36))).applied).toBe(true)
  expect(typeof call('slides:history-batch-end')).toBe('number')
  expect(call('slides:set-notes', { slideIndex: 0, text: 'manual after' })).toBe(true)
  call('slides:undo')
  expect(getSlideNotes(session.opened.archive, slide.path)).toBe('현장 노트')
  call('slides:undo')
  expect(getSlideNotes(session.opened.archive, slide.path)).toBe(firstNotes)
  const verify = (n: number) =>
    expect(values()).toEqual(ids.map((_, i) => (i < n ? '번역 ' + i : 'Source ' + i)))
  verify(64)
  for (let n = 63; n >= 0; n--) {
    call('slides:undo')
    verify(n)
  }
  for (let n = 1; n <= 64; n++) {
    call('slides:redo')
    verify(n)
  }
  call('slides:redo')
  expect(getSlideNotes(session.opened.archive, slide.path)).toBe('현장 노트')
  call('slides:redo')
  expect(getSlideNotes(session.opened.archive, slide.path)).toBe('manual after')
}, 30000)

it('restores table cells, their exact XML and dirty flag, and rolls back a rejected translation batch', async () => {
  const tab = addTable(session.opened, 0, {
    rows: 8,
    cols: 8,
    offset: { x: 0, y: 0, cx: 3810000, cy: 952500 },
  })!
  const slide = session.opened.deck.slides[0]!
  const initialDirty = slide.structureDirty
  const table = () => session.opened.deck.slides[0]!.elements.find((e) => e.type === 'table')!
  const before = table().anchor.originalXml
  const op = (row: number, col: number, text: string) => ({
    op: 'setTableCell',
    target: { slide: 0, el: tab.elementId },
    row,
    col,
    paragraphs: [{ runs: [{ text }] }],
  })
  const apply = (ops: unknown[]) =>
    call('slides:apply-txn:ai-edit', [{ ops, translation: true, acceptSlideUpdate: true }], true)
  expect((await apply([op(0, 0, 'Should revert'), op(99, 99, 'Invalid')])).applied).toBe(false)
  expect(table().anchor.originalXml).toBe(before)
  expect(session.metaDirty).toBeFalsy()
  expect(session.undoStack).toHaveLength(0)
  const ops = Array.from({ length: 64 }, (_, i) => op(Math.floor(i / 8), i % 8, '번역 ' + i))
  call('slides:history-batch-begin', { aiRun: true })
  expect((await apply(ops.slice(0, 32))).applied).toBe(true)
  expect((await apply(ops.slice(32))).applied).toBe(true)
  call('slides:history-batch-end')
  const final = table().anchor.originalXml
  const steps = session.undoStack.at(-1)!.translation!
  for (const step of steps.slice(1)) {
    expect(step.target.kind).toBe('cell')
    if (step.target.kind === 'cell') expect(step.target.xml.insert.length).toBeLessThan(2000)
  }
  for (let i = 63; i >= 0; i--) {
    call('slides:undo')
    expect(table().rows[Math.floor(i / 8)]![i % 8]!.text?.paragraphs[0]?.runs[0]?.text).not.toBe(
      '번역 ' + i,
    )
  }
  expect(table().anchor.originalXml).toBe(before)
  expect(session.opened.deck.slides[0]!.structureDirty).toBe(initialDirty)
  for (let i = 0; i < 64; i++) {
    call('slides:redo')
    expect(table().rows[Math.floor(i / 8)]![i % 8]!.text?.paragraphs[0]?.runs[0]?.text).toBe(
      '번역 ' + i,
    )
  }
  expect(table().anchor.originalXml).toBe(final)
}, 30000)
