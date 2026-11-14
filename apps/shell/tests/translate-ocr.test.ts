import { describe, expect, it, vi } from 'vitest'
import type { OcrMode, SourceEntry } from '@genoffice/translate-project'
import {
  EmptyOcrSelectionError,
  InvalidOcrSelectionError,
  OcrCancelledError,
  OcrDisabledError,
  OcrFailedError,
  resolveOcrSelection,
  runOcr,
  type OcrAsk,
  type OcrBridge,
  type OcrPrepared,
} from '../src/shared/translate-ocr'

/**
 * runOcr against a fake bridge and a fake ask: no AI, no files. The ask
 * answers a minimal transcription so the engine's parser accepts it.
 */

const PDF: SourceEntry = { file: 'scan.pdf', sha256: 'x', kind: 'scan' }
const ANSWER = '<page-content>\nHello\n</page-content>'

function setup(ocr: OcrMode = { kind: 'ai', provider: 'claude' }, count = 5) {
  const prepared: OcrPrepared = {
    token: 'tok',
    kind: 'pdf',
    ocr,
    items: Array.from({ length: count }, (_, i) => ({ index: i + 1, name: '' })),
  }
  const rendered: number[] = []
  const bridge = {
    prepare: vi.fn(async () => prepared),
    start: vi.fn(async () => undefined),
    pageImage: vi.fn(async (_token: string, index: number) => {
      rendered.push(index)
      return { data: new Uint8Array([index]), mime: 'image/png' as const }
    }),
    write: vi.fn(async () => ({ outputPath: '/p/output/scan (OCR).docx' })),
    release: vi.fn(async () => undefined),
  } satisfies OcrBridge
  const ask = vi.fn<OcrAsk>(async () => ANSWER)
  return { prepared, bridge, ask, rendered }
}

describe('runOcr', () => {
  it('runOcr with off throws OcrDisabledError and never calls the provider', async () => {
    const { bridge, ask } = setup({ kind: 'off' })
    const confirm = vi.fn(async () => true)
    await expect(
      runOcr({ dir: '/p', source: PDF, selection: { kind: 'all' }, confirm, bridge, ask }),
    ).rejects.toBeInstanceOf(OcrDisabledError)
    expect(ask).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(bridge.start).not.toHaveBeenCalled()
    expect(bridge.pageImage).not.toHaveBeenCalled()
    expect(bridge.release).toHaveBeenCalledWith('tok')
  })

  it('runOcr never sends images when confirm resolves false', async () => {
    const { bridge, ask } = setup()
    await expect(
      runOcr({
        dir: '/p',
        source: PDF,
        selection: { kind: 'all' },
        confirm: async () => false,
        bridge,
        ask,
      }),
    ).rejects.toBeInstanceOf(OcrCancelledError)
    expect(bridge.start).not.toHaveBeenCalled()
    expect(bridge.pageImage).not.toHaveBeenCalled()
    expect(ask).not.toHaveBeenCalled()
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('runOcr sends only the selected pages and passes their count to confirm', async () => {
    const { bridge, ask, rendered } = setup()
    const confirm = vi.fn(async () => true)
    const out = await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'pages', pages: [4, 2] },
      confirm,
      bridge,
      ask,
    })
    expect(confirm).toHaveBeenCalledWith(2)
    expect(bridge.start).toHaveBeenCalledWith('tok', [2, 4])
    expect(rendered.sort()).toEqual([2, 4])
    expect(ask).toHaveBeenCalledTimes(2)
    const sent = ask.mock.calls.map((c) => c[1].messages[0]!.images![0]!.base64)
    // the bytes [2] and [4] as base64
    expect(sent.sort()).toEqual(['Ag==', 'BA=='])
    expect(out.read).toEqual([2, 4])
    expect(bridge.write).toHaveBeenCalledWith('tok', [
      { index: 2, payload: expect.objectContaining({ version: 1 }) },
      { index: 4, payload: expect.objectContaining({ version: 1 }) },
    ])
  })

  it('runOcr with selection all sends every page', async () => {
    const { bridge, ask, rendered } = setup(undefined, 3)
    const confirm = vi.fn(async () => true)
    await runOcr({ dir: '/p', source: PDF, selection: { kind: 'all' }, confirm, bridge, ask })
    expect(confirm).toHaveBeenCalledWith(3)
    expect(rendered.sort()).toEqual([1, 2, 3])
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('runOcr with an empty pages selection throws EmptyOcrSelectionError and never calls the provider', async () => {
    const { bridge, ask } = setup()
    const confirm = vi.fn(async () => true)
    await expect(
      runOcr({
        dir: '/p',
        source: PDF,
        selection: { kind: 'pages', pages: [] },
        confirm,
        bridge,
        ask,
      }),
    ).rejects.toBeInstanceOf(EmptyOcrSelectionError)
    expect(ask).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(bridge.prepare).not.toHaveBeenCalled()
  })

  it("runOcr uses the provider chosen in the project's OCR setting", async () => {
    const { bridge, ask } = setup({ kind: 'ai', provider: 'chatgpt' }, 2)
    await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'all' },
      confirm: async () => true,
      bridge,
      ask,
    })
    expect(ask.mock.calls.map((c) => c[0])).toEqual(['chatgpt', 'chatgpt'])
  })

  it('runOcr returns the docx path main wrote', async () => {
    const { bridge, ask } = setup(undefined, 1)
    const out = await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'all' },
      confirm: async () => true,
      bridge,
      ask,
    })
    expect(out.outputPath).toBe('/p/output/scan (OCR).docx')
  })

  it('several images are prepared together and selected by their list position', async () => {
    const { bridge, ask } = setup(undefined, 3)
    const images: SourceEntry[] = ['a.png', 'b.jpg', 'c.png'].map((file) => ({
      file,
      sha256: 'x',
      kind: 'image',
    }))
    await runOcr({
      dir: '/p',
      source: images,
      selection: { kind: 'pages', pages: [3] },
      confirm: async () => true,
      bridge,
      ask,
    })
    expect(bridge.prepare).toHaveBeenCalledWith('/p', ['a.png', 'b.jpg', 'c.png'])
    expect(bridge.start).toHaveBeenCalledWith('tok', [3])
  })

  it('a listing the screen holds is used and left for the screen to release', async () => {
    const { bridge, ask, prepared } = setup(undefined, 2)
    await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'all' },
      confirm: async () => false,
      bridge,
      ask,
      prepared,
    }).catch(() => undefined)
    expect(bridge.prepare).not.toHaveBeenCalled()
    expect(bridge.release).not.toHaveBeenCalled()
  })

  it('a malformed page is reported as failed and the rest is written', async () => {
    const { bridge, ask } = setup(undefined, 2)
    ask.mockImplementation(async (_p, request) =>
      request.messages[0]!.images![0]!.base64 === 'AQ==' ? 'no tags here' : ANSWER,
    )
    const out = await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'all' },
      confirm: async () => true,
      bridge,
      ask,
    })
    expect(out.failed).toEqual([1])
    expect(out.read).toEqual([2])
  })

  it('a used-up limit stops at once and nothing more is sent', async () => {
    const { bridge, ask } = setup(undefined, 6)
    ask.mockRejectedValue(Object.assign(new Error('limit'), { kind: 'rate-limit' }))
    await expect(
      runOcr({
        dir: '/p',
        source: PDF,
        selection: { kind: 'all' },
        confirm: async () => true,
        bridge,
        ask,
      }),
    ).rejects.toBeInstanceOf(OcrFailedError)
    // the two calls already in flight, nothing after them
    expect(ask.mock.calls.length).toBeLessThanOrEqual(2)
    expect(bridge.write).not.toHaveBeenCalled()
  })

  it('stopping keeps what was read before and sends nothing after', async () => {
    const { bridge, ask } = setup(undefined, 5)
    const controller = new AbortController()
    let calls = 0
    ask.mockImplementation(async () => {
      if (++calls === 2) controller.abort()
      return ANSWER
    })
    const out = await runOcr({
      dir: '/p',
      source: PDF,
      selection: { kind: 'all' },
      confirm: async () => true,
      bridge,
      ask,
      signal: controller.signal,
    })
    expect(out.stopped).toBe('cancelled')
    expect(ask.mock.calls.length).toBe(2)
    expect(out.read.length).toBeGreaterThan(0)
  })
})

describe('resolveOcrSelection', () => {
  it('all is every position in order', () => {
    expect(resolveOcrSelection({ kind: 'all' }, 3)).toEqual([1, 2, 3])
  })
  it('sorts the chosen positions', () => {
    expect(resolveOcrSelection({ kind: 'pages', pages: [3, 1] }, 3)).toEqual([1, 3])
  })
  it.each([[[0]], [[4]], [[1.5]], [['1']], [[1, 1]], [[Number.NaN]]])(
    'rejects %j out of 3',
    (pages) => {
      expect(() => resolveOcrSelection({ kind: 'pages', pages }, 3)).toThrow(
        InvalidOcrSelectionError,
      )
    },
  )
  it('rejects an unknown shape', () => {
    expect(() => resolveOcrSelection({ kind: 'some' }, 3)).toThrow(InvalidOcrSelectionError)
    expect(() => resolveOcrSelection(null, 3)).toThrow(InvalidOcrSelectionError)
  })
  it('rejects an empty pick', () => {
    expect(() => resolveOcrSelection({ kind: 'pages', pages: [] }, 3)).toThrow(
      EmptyOcrSelectionError,
    )
  })
})

it('waits for OCR review and an explicit placement before writing an embedded result', async () => {
  const { prepared, bridge, ask } = setup(undefined, 1)
  prepared.kind = 'embedded'
  prepared.format = 'xlsx'
  bridge.write.mockResolvedValue({ outputPath: '/p/output/source (OCR).xlsx' })
  let resolvePlacement!: (placement: any) => void
  const choosePlacement = vi.fn(
    () =>
      new Promise<any>((resolve) => {
        resolvePlacement = resolve
      }),
  )
  const pending = runOcr({
    dir: '/p',
    source: { file: 'source.xlsx', kind: 'editable', sha256: 'x' },
    prepared,
    selection: { kind: 'all' },
    confirm: async () => true,
    bridge,
    ask,
    choosePlacement,
  })
  await vi.waitFor(() => expect(choosePlacement).toHaveBeenCalledTimes(1))
  expect(bridge.write).not.toHaveBeenCalled()
  resolvePlacement({ kind: 'xlsx-cells', sheet: 'Sheet1', cell: 'C7', overwrite: false })
  const result = await pending
  expect(result.outputPath).toMatch(/\.xlsx$/)
  expect(bridge.write).toHaveBeenCalledWith('tok', expect.any(Array), {
    kind: 'xlsx-cells',
    sheet: 'Sheet1',
    cell: 'C7',
    overwrite: false,
  })
})

describe('runOcr box reading of embedded docx pictures', () => {
  const BOXES = `<boxes>${JSON.stringify([
    { x: 100, y: 100, w: 300, h: 100, font: 50, text: 'Name' },
  ])}</boxes>`

  function embeddedSetup() {
    const prepared: OcrPrepared = {
      token: 'tok',
      kind: 'embedded',
      format: 'docx',
      ocr: { kind: 'ai', provider: 'claude' },
      items: [
        { index: 1, name: 'a.png', boxable: true },
        { index: 2, name: 'b.png' },
      ],
    }
    const written: unknown[] = []
    const bridge = {
      prepare: vi.fn(async () => prepared),
      start: vi.fn(async () => undefined),
      pageImage: vi.fn(async (_token: string, index: number) => ({
        data: new Uint8Array([index]),
        mime: 'image/png' as const,
      })),
      write: vi.fn(async (_token: string, pages: unknown[]) => {
        written.push(...pages)
        return { outputPath: '/p/output/doc (OCR).docx' }
      }),
      release: vi.fn(async () => undefined),
    } satisfies OcrBridge
    const ask = vi.fn<OcrAsk>(async (_provider, request) =>
      request.system.includes('<boxes>') ? BOXES : ANSWER,
    )
    return { prepared, bridge, ask, written }
  }
  const run = (boxes: boolean | undefined) => {
    const { prepared, bridge, ask, written } = embeddedSetup()
    const promise = runOcr({
      dir: '/p',
      source: { file: 'doc.docx', sha256: 'x', kind: 'editable' },
      selection: { kind: 'all' },
      confirm: async () => true,
      bridge,
      ask,
      prepared,
      ...(boxes === undefined ? {} : { boxes }),
      choosePlacement: async () => ({ kind: 'docx-after-images' }),
    })
    return { promise, ask, written }
  }

  it('reads boxable items with the box request and the others with the page request', async () => {
    const { promise, ask, written } = run(true)
    await promise
    const systems = ask.mock.calls.map(([, request]) => request.system.includes('<boxes>'))
    expect(systems.filter(Boolean)).toHaveLength(1)
    expect(systems.filter((box) => !box)).toHaveLength(1)
    const byIndex = new Map(
      (written as { index: number; payload: { kind?: string } }[]).map((p) => [p.index, p.payload]),
    )
    expect(byIndex.get(1)).toMatchObject({ kind: 'boxes', text: 'Name' })
    expect(byIndex.get(2)).not.toHaveProperty('kind', 'boxes')
  })

  it('does not use the box request when boxes is not set', async () => {
    const { promise, ask } = run(undefined)
    await promise
    expect(ask.mock.calls.every(([, request]) => !request.system.includes('<boxes>'))).toBe(true)
  })
})
