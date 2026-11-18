// @vitest-environment jsdom
/**
 * The marks the plugin draws on the pages over the places it changed, against the real
 * rhwp engine. The editor's view (where pages sit, the zoom) is a stand-in: pages one under
 * another, 2000 pixels apart, 10 pixels from the left, at zoom 2.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import init, { HwpDocument } from '@rhwp/core'
import { agentPlugin, type AgentPluginHost } from '../studio-plugin/agent-plugin.mjs'

const require = createRequire(import.meta.url)

beforeAll(async () => {
  const wasm = join(dirname(require.resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

const PAGE_GAP = 2000
const PAGE_LEFT = 10
const ZOOM = 2

interface Rect {
  pageIndex: number
  x: number
  y: number
  width: number
  height: number
}

function open(lines: string[], prepare?: (doc: HwpDocument) => void) {
  document.body.innerHTML = '<div id="scroll-container"><div id="scroll-content"></div></div>'
  const doc = HwpDocument.createEmpty()
  doc.createBlankDocument()
  lines.forEach((line, k) => {
    if (k > 0) doc.splitParagraph(0, k - 1, doc.getParagraphLength(0, k - 1))
    doc.insertText(0, k, 0, line)
  })
  prepare?.(doc)
  const listeners: (() => void)[] = []
  const commands = new Map<string, (services: unknown) => void>()
  const services = {
    getInputHandler: () => ({
      virtualScroll: {
        getPageOffset: (page: number) => page * PAGE_GAP,
        getPageLeftResolved: () => PAGE_LEFT,
      },
    }),
    getViewportManager: () => ({ getZoom: () => ZOOM }),
  }
  const host = {
    read: (fn: (d: never) => unknown) => fn(doc as never),
    transaction: (_label: string, fn: (tx: never) => unknown) => {
      const result = fn({ doc: () => doc, deferPagination: () => {} } as never)
      for (const listener of listeners) listener()
      return result
    },
    events: { on: (_name: string, handler: () => void) => listeners.push(handler) },
    automation: {
      registerCommand: (def: { id: string; execute: (services: unknown) => void }) =>
        commands.set(def.id, def.execute),
      execute: (id: string) => commands.get(id)?.(services) ?? null,
    },
  } as unknown as AgentPluginHost
  const plugin = agentPlugin.activate(host)
  /** an edit the user makes: the editor says the document changed */
  const userEdit = () => {
    doc.insertText(0, 0, 0, '손')
    for (const listener of listeners) listener()
  }
  return { plugin, doc, userEdit, redraw: () => host.automation.execute('ext:ieum-mark-changes') }
}

/** The marks on the page, as page rectangles again. */
function marksOnPage(): Rect[] {
  return [...document.querySelectorAll<HTMLElement>('.ieum-change-marks > div')].map((box) => {
    const top = parseFloat(box.style.top)
    const pageIndex = Math.floor(top / PAGE_GAP)
    return {
      pageIndex,
      x: Math.round((parseFloat(box.style.left) - PAGE_LEFT) / ZOOM),
      y: Math.round((top - pageIndex * PAGE_GAP) / ZOOM),
      width: Math.round(parseFloat(box.style.width) / ZOOM),
      height: Math.round(parseFloat(box.style.height) / ZOOM),
    }
  })
}

/** Where the engine lays out a run of a body paragraph, rounded as marksOnPage rounds. */
function rectsOf(doc: HwpDocument, para: number, start: number, end: number): Rect[] {
  return (JSON.parse(doc.getSelectionRects(0, para, start, para, end)) as Rect[]).map((r) => ({
    pageIndex: r.pageIndex,
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }))
}

const textOf = (doc: HwpDocument, para: number) =>
  doc.getTextRange(0, para, 0, doc.getParagraphLength(0, para))

afterEach(() => {
  agentPlugin.deactivate?.()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('marks of changes', () => {
  it('uses hinted geometry when header repetition is enabled but no cells are headers', () => {
    const { plugin, doc } = open(['prefix', ''], (d) => {
      d.pasteHtml(0, 1, 0, '<table><tr><td>target</td><td>target</td></tr></table>')
      d.setTableProperties(0, 1, 0, JSON.stringify({ repeatHeader: true }))
    })
    const full = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
    const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
    const dimensions = vi.spyOn(doc, 'getTableDimensions')
    plugin.replaceAllText('target', 'changed')
    expect(full).not.toHaveBeenCalled()
    expect(hinted).toHaveBeenCalledTimes(2)
    expect(dimensions).toHaveBeenCalledTimes(1)
    const expected = [0, 1].flatMap(
      (cellIndex) =>
        JSON.parse(
          doc.getSelectionRectsInCellByPath(
            0,
            1,
            JSON.stringify([{ controlIndex: 0, cellIndex, cellParaIndex: 0 }]),
            0,
            0,
            0,
            7,
          ),
        ) as Rect[],
    )
    expect(marksOnPage()).toEqual(
      expected.map((r) => ({
        pageIndex: r.pageIndex,
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })),
    )
  })

  it('keeps the entire repeated header row on the full query and hints ordinary rows', () => {
    const { plugin, doc } = open(['prefix', ''], (d) => {
      d.pasteHtml(
        0,
        1,
        0,
        '<table><tr><td>target</td><td>target</td></tr><tr><td>target</td><td>target</td></tr></table>',
      )
      d.setTableProperties(0, 1, 0, JSON.stringify({ repeatHeader: true }))
      d.setCellProperties(0, 1, 0, 0, JSON.stringify({ isHeader: true }))
    })
    const full = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
    const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
    const dimensions = vi.spyOn(doc, 'getTableDimensions')
    const cellProperties = vi.spyOn(doc, 'getCellProperties')
    plugin.replaceAllText('target', 'changed')
    expect(full.mock.calls.map((call) => JSON.parse(call[2])[0].cellIndex)).toEqual([0, 1])
    expect(
      hinted.mock.calls.map((call) => JSON.parse(JSON.parse(call[0]).path)[0].cellIndex),
    ).toEqual([2, 3])
    expect(dimensions).toHaveBeenCalledTimes(1)
    expect(cellProperties).toHaveBeenCalledTimes(4)
    const expected = [0, 1, 2, 3].flatMap(
      (cellIndex) =>
        JSON.parse(
          doc.getSelectionRectsInCellByPath(
            0,
            1,
            JSON.stringify([{ controlIndex: 0, cellIndex, cellParaIndex: 0 }]),
            0,
            0,
            0,
            7,
          ),
        ) as Rect[],
    )
    expect(marksOnPage()).toEqual(
      expected.map((r) => ({
        pageIndex: r.pageIndex,
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })),
    )
  })

  it('protects every row spanned by a header cell, including unflagged neighbouring cells', () => {
    const { plugin, doc } = open(['prefix', ''], (d) => {
      d.pasteHtml(
        0,
        1,
        0,
        '<table><tr><td>header</td><td>top</td></tr><tr><td>covered</td><td>target</td></tr><tr><td>bottom</td><td>target</td></tr></table>',
      )
      d.mergeTableCells(0, 1, 0, 0, 0, 1, 0)
      d.setTableProperties(0, 1, 0, JSON.stringify({ repeatHeader: true }))
      d.setCellProperties(0, 1, 0, 0, JSON.stringify({ isHeader: true }))
    })
    expect(JSON.parse(doc.getCellInfo(0, 1, 0, 0)).rowSpan).toBe(2)
    const full = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
    const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
    plugin.replaceAllText('target', 'changed')
    expect(full).toHaveBeenCalledTimes(1)
    expect(hinted).toHaveBeenCalledTimes(1)
    const protectedCell = JSON.parse(full.mock.calls[0][2])[0].cellIndex
    const ordinaryCell = JSON.parse(JSON.parse(hinted.mock.calls[0][0]).path)[0].cellIndex
    expect(JSON.parse(doc.getCellInfo(0, 1, 0, protectedCell)).row).toBe(1)
    expect(JSON.parse(doc.getCellInfo(0, 1, 0, ordinaryCell)).row).toBe(2)
    expect(marksOnPage()).toHaveLength(2)
  })

  it.each(['over budget', 'missing header flag', 'failed metadata'])(
    'keeps full geometry for %s without rescanning the table',
    (reason) => {
      const { plugin, doc } = open(['prefix', ''], (d) => {
        d.pasteHtml(0, 1, 0, '<table><tr><td>target</td><td>target</td></tr></table>')
        d.setTableProperties(0, 1, 0, JSON.stringify({ repeatHeader: true }))
      })
      const dimensions = vi.spyOn(doc, 'getTableDimensions')
      const properties = vi.spyOn(doc, 'getCellProperties')
      if (reason === 'over budget')
        dimensions.mockReturnValue(JSON.stringify({ cellCount: 2001, rowCount: 1 }))
      else if (reason === 'missing header flag') properties.mockReturnValue('{}')
      else
        properties.mockImplementation(() => {
          throw new Error('metadata unavailable')
        })
      const full = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
      const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
      plugin.replaceAllText('target', 'changed')
      expect(full).toHaveBeenCalledTimes(2)
      expect(hinted).not.toHaveBeenCalled()
      expect(dimensions).toHaveBeenCalledTimes(1)
      expect(properties).toHaveBeenCalledTimes(reason === 'over budget' ? 0 : 1)
      expect(marksOnPage()).toHaveLength(2)
    },
  )

  it('reuses page geometry for redraws, but refreshes it after layout settles or text changes', () => {
    vi.useFakeTimers()
    const { plugin, doc, redraw } = open(['first', 'target'])
    const geometry = vi.spyOn(doc, 'getSelectionRects')
    plugin.replaceText('target', 'changed', null)
    expect(geometry).toHaveBeenCalledTimes(1)
    const before = marksOnPage()
    for (let i = 0; i < 20; i++) redraw()
    expect(marksOnPage()).toEqual(before)
    expect(geometry).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(350)
    expect(geometry).toHaveBeenCalledTimes(2)
    // Late layout can resize the content even after the settle timer has fired.
    Object.defineProperty(document.querySelector('#scroll-content'), 'clientHeight', {
      value: 4000,
      configurable: true,
    })
    redraw()
    expect(geometry).toHaveBeenCalledTimes(3)
    plugin.replaceText('changed', 'new text', null)
    expect(geometry.mock.calls.length).toBeGreaterThan(3)
  })

  it('does not revive a removed mark layer after deactivation', () => {
    vi.useFakeTimers()
    const { plugin } = open(['target'])
    plugin.replaceText('target', 'changed', null)
    agentPlugin.deactivate?.()
    vi.advanceTimersByTime(400)
    expect(document.querySelector('.ieum-change-marks')).toBeNull()
  })

  it('limits cell geometry to its actual endpoint pages without changing its rectangles', () => {
    const { plugin, doc } = open(
      Array.from({ length: 35 }, () => 'Filler paragraph. '.repeat(12)),
      (d) => {
        d.pasteHtml(0, 34, 0, '<table><tr><td>target</td></tr></table>')
      },
    )
    const scan = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
    const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
    plugin.replaceText('target', 'changed', null)
    expect(scan).not.toHaveBeenCalled()
    expect(hinted).toHaveBeenCalledTimes(1)
    const query = JSON.parse(hinted.mock.calls[0][0])
    expect(query.startPageHint).toBeGreaterThan(0)
    const expected = JSON.parse(
      doc.getSelectionRectsInCellByPath(
        query.sectionIdx,
        query.parentParaIdx,
        query.path,
        query.startCellParaIdx,
        query.startCharOffset,
        query.endCellParaIdx,
        query.endCharOffset,
      ),
    ) as Rect[]
    expect(marksOnPage()).toEqual(
      expected.map((r) => ({
        pageIndex: r.pageIndex,
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })),
    )
  })

  it.each(['unknown header metadata', 'missing endpoint'])(
    'keeps full path geometry for %s',
    (reason) => {
      const { plugin, doc } = open([''], (d) => {
        d.pasteHtml(0, 0, 0, '<table><tr><td>target</td></tr></table>')
      })
      if (reason === 'unknown header metadata') {
        vi.spyOn(doc, 'getTableProperties').mockReturnValue('{}')
      } else {
        vi.spyOn(doc, 'getCursorRectByPath').mockImplementation(() => {
          throw new Error('unavailable')
        })
      }
      const scan = vi.spyOn(doc, 'getSelectionRectsInCellByPath')
      const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
      plugin.replaceText('target', 'changed', null)
      expect(scan).toHaveBeenCalledTimes(1)
      expect(hinted).not.toHaveBeenCalled()
      expect(marksOnPage().length).toBeGreaterThan(0)
    },
  )

  it('keeps every line of a marked cell spanning several pages', () => {
    const { plugin, doc } = open(['prefix', ''], (d) => {
      d.pasteHtml(0, 1, 0, '<table><tr><td>target</td></tr></table>')
      d.setTableProperties(
        0,
        1,
        0,
        JSON.stringify({ pageBreak: 1, treatAsChar: false, restrictInPage: false }),
      )
    })
    const hinted = vi.spyOn(doc, 'getSelectionRectsInCellByPathEx')
    plugin.replaceText('target', 'Long cell text. '.repeat(1000), null)
    const query = JSON.parse(hinted.mock.calls[0][0])
    const expected = JSON.parse(
      doc.getSelectionRectsInCellByPath(
        query.sectionIdx,
        query.parentParaIdx,
        query.path,
        query.startCellParaIdx,
        query.startCharOffset,
        query.endCellParaIdx,
        query.endCharOffset,
      ),
    ) as Rect[]
    expect(new Set(expected.map((r) => r.pageIndex)).size).toBeGreaterThan(1)
    expect(marksOnPage()).toEqual(
      expected.map((r) => ({
        pageIndex: r.pageIndex,
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      })),
    )
  })

  it('marks the text a replacement put in', () => {
    const { plugin, doc } = open(['제출 기한은 3월 2일', '담당자: 홍길동'])
    plugin.replaceText('홍길동', '김철수', null)
    expect(marksOnPage()).toEqual(rectsOf(doc, 1, 5, 8))
  })

  it('marks every place of a replace-all, a later one in a paragraph where it moved to', () => {
    const { plugin, doc } = open(['가 가 가', '가'])
    plugin.replaceAllText('가', '나다')
    expect(textOf(doc, 0)).toBe('나다 나다 나다')
    expect(marksOnPage()).toEqual([
      ...rectsOf(doc, 0, 0, 2),
      ...rectsOf(doc, 0, 3, 5),
      ...rectsOf(doc, 0, 6, 8),
      ...rectsOf(doc, 1, 0, 2),
    ])
  })

  it('marks each paragraph it added, and moves the marks of earlier changes below them', () => {
    const { plugin, doc } = open(['첫째', '둘째', '셋째'])
    plugin.replaceText('셋째', '세 번째', null)
    plugin.insertParagraphs('첫째', null, 'after', ['새 하나', '새 둘'])
    expect(textOf(doc, 4)).toBe('세 번째')
    expect(marksOnPage()).toEqual([
      ...rectsOf(doc, 4, 0, 4),
      ...rectsOf(doc, 1, 0, 4),
      ...rectsOf(doc, 2, 0, 3),
    ])
  })

  it('marks nothing for a removed paragraph, and moves the marks below it up', () => {
    const { plugin, doc } = open(['첫째', '둘째', '셋째'])
    plugin.replaceText('둘째', '두 번째', null)
    plugin.replaceText('셋째', '세 번째', null)
    plugin.deleteParagraph('두 번째', null)
    expect(textOf(doc, 1)).toBe('세 번째')
    // the removed paragraph's mark went with it
    expect(marksOnPage()).toEqual(rectsOf(doc, 1, 0, 4))
  })

  it('takes the marks off when the panel asks, or when the user edits the document', () => {
    const first = open(['가격 표', '금액'])
    first.plugin.replaceText('금액', '합계', null)
    expect(marksOnPage().length).toBeGreaterThan(0)
    first.plugin.clearMarks()
    expect(marksOnPage()).toEqual([])

    const second = open(['가격 표', '금액'])
    second.plugin.replaceText('금액', '합계', null)
    second.userEdit()
    expect(marksOnPage()).toEqual([])
  })

  it('gives the panel no list of marks in what a change returns', () => {
    const { plugin } = open(['가 가'])
    const result = plugin.replaceAllText('가', '나')
    expect(result).not.toHaveProperty('marks')
  })
})
