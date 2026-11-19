import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderSlide } from '@genoffice/pptx-render'
import { viewportImageUrls } from '../src/renderer/slide-image-urls'
import { renderSlidesToPdfPages } from '../src/renderer/export-pages'
import { renderSlidesToPngBase64 } from '../src/renderer/export-render'

type Capture = { slide: RenderSlide; images: Map<string, HTMLImageElement> }
const { pngCapture, svgCapture } = vi.hoisted(() => ({
  pngCapture: vi.fn<(page: Capture) => void>(),
  svgCapture: vi.fn<(page: Capture) => void>(),
}))
vi.mock('react-konva', () => ({ Stage: () => null, Layer: () => null }))
vi.mock('../src/renderer/SlideThumb', () => ({ SlideThumb: () => null }))
vi.mock('../src/renderer/NodeBody', () => ({ StaticNode: () => null }))
vi.mock('react-dom/client', () => ({
  createRoot: () => ({
    render: ({ props }: { props: Capture & { stageRef: (stage: unknown) => void } }) => {
      pngCapture(props)
      props.stageRef({ toDataURL: () => 'data:image/png;base64,page' })
    },
    unmount: vi.fn(),
  }),
}))
vi.mock('../src/renderer/export-svg', () => ({
  renderSlideToSvg: (slide: RenderSlide, images: Map<string, HTMLImageElement>) => {
    svgCapture({ slide, images })
    return { svg: '<svg/>', fontFamilies: [] }
  },
}))
vi.mock('../src/renderer/export-fonts', () => ({ collectExportFontCss: async () => '' }))

const fill = (url: string) => ({ kind: 'image', dataUrl: url })
const deckPage = (n: number) =>
  ({
    widthPx: 960,
    heightPx: 540,
    background: fill('shared'),
    hidden: n === 2,
    nodes: [
      {
        type: 'group',
        children: [{ type: 'group', children: [{ type: 'picture', dataUrl: String(n) }] }],
      },
      {
        type: 'table',
        cells: [{ fill: fill('shared'), text: { lines: [{ runs: [{ image: 'bullet' }] }] } }],
      },
    ],
  }) as unknown as RenderSlide

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('slide images', () => {
  it('walks just the requested pages in order and picks up replacement pages after edits', () => {
    const slides = [deckPage(0), deckPage(1), deckPage(2), deckPage(3)]
    Object.defineProperty(slides, 0, {
      get: () => {
        throw new Error('unvisited slide')
      },
    })
    expect([...viewportImageUrls(slides, [3, 2, 3])]).toEqual(['shared', '3', 'bullet', '2'])
    slides[3] = deckPage(4)
    expect([...viewportImageUrls(slides, [3])]).toEqual(['shared', '4', 'bullet'])
  })

  it('cancels the offscreen render when the print preview closes mid-decode', async () => {
    const started: string[] = []
    vi.stubGlobal(
      'Image',
      class {
        set src(url: string) {
          started.push(url)
        }
      },
    )
    const controller = new AbortController()
    const output = renderSlidesToPngBase64(
      [deckPage(0), deckPage(1)],
      new Map(),
      2,
      controller.signal,
    )
    controller.abort()
    await expect(output).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toEqual(['shared', '0', 'bullet'])
    expect(pngCapture).not.toHaveBeenCalled()
  })

  it('fails export when no pending picture makes progress', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('Image', class {})
      const output = renderSlidesToPdfPages([deckPage(1)], new Map())
      const failure = expect(output).rejects.toThrow('Slide images stopped loading')
      await vi.advanceTimersByTimeAsync(30_000)
      await failure
      expect(svgCapture).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['print', 'PDF'] as const)(
    'waits for unvisited images before %s page capture',
    async (mode) => {
      const decoded: string[] = []
      vi.stubGlobal(
        'Image',
        class {
          onload: (() => void) | null = null
          set src(url: string) {
            queueMicrotask(() => {
              decoded.push(url)
              this.onload?.()
            })
          }
        },
      )
      const cached = new Map([['0', {} as HTMLImageElement]])
      const slides = Array.from({ length: 5 }, (_, i) => deckPage(i))
      const pages = mode === 'print' ? slides : slides.filter((s) => !s.hidden)
      if (mode === 'print') await renderSlidesToPngBase64(pages, cached)
      else await renderSlidesToPdfPages(pages, cached)
      const capture = mode === 'print' ? pngCapture : svgCapture
      expect(capture.mock.calls.map(([{ images }]) => [...images.keys()].sort())).toEqual(
        pages.map((slide) => [String(slides.indexOf(slide)), 'bullet', 'shared']),
      )
      expect(decoded).toEqual([
        'shared',
        'bullet',
        ...pages.slice(1).map((s) => String(slides.indexOf(s))),
      ])
    },
  )
})
