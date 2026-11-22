import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOcrPicturesSkill } from '../src/renderer/ai/ocr-pictures-skill'
import { en } from '../src/renderer/i18n/ai/en'
import { zh } from '../src/renderer/i18n/ai/zh'

afterEach(() => vi.unstubAllGlobals())

const call = (input: Record<string, unknown>, name = 'ocr_pictures') => ({
  id: 'c1',
  name,
  input,
})

const listing = (rows: number[]) => ({
  total: rows.length,
  pictures: rows.map((row, i) => ({ index: i + 1, sheet: 'Webtoon', cell: `A${row}` })),
})

function stub(over: Record<string, unknown> = {}) {
  const ocrPictures = vi.fn(async (request: { action: string }) =>
    request.action === 'list'
      ? { ok: true, ...listing([7, 82, 157, 232, 275]) }
      : { ok: true, opened: true },
  )
  vi.stubGlobal('window', { desktopApi: { ocrPictures, ...over } })
  return ocrPictures
}

describe('ocr_pictures skill', () => {
  it('exposes picture discovery, the popup and confirmed-result pagination without accepting file paths', () => {
    const skill = createOcrPicturesSkill(() => 'session-1')
    expect(skill.tools?.map((tool) => tool.name)).toEqual(['ocr_pictures'])
    const schema = skill.tools?.[0]?.inputSchema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties).sort()).toEqual([
      'action',
      'offset',
      'position',
      'resultId',
    ])
  })

  it('lists the pictures in document order with anchor cells, count and destination hint', async () => {
    const api = stub()
    const result = await createOcrPicturesSkill(() => 'session-1').executeTool(
      call({ action: 'list' }),
    )
    expect(api).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'list' })
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBeFalsy()
    expect(result.output).toContain('5 pictures')
    expect(result.output).toContain('document order')
    expect(result.output).toMatch(/1\. Webtoon!A7/)
    expect(result.output).toMatch(/5\. Webtoon!A275/)
    expect(result.output).toMatch(/nothing is sent/i)
    expect(result.summary).toBe(zh.aiToolOcrPicturesDone.replace('{count}', '5'))
  })

  it('caps a long list but keeps the count and the last picture', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => 7 + i * 10)
    vi.stubGlobal('window', {
      desktopApi: { ocrPictures: vi.fn(async () => ({ ok: true, ...listing(rows) })) },
    })
    const result = await createOcrPicturesSkill(() => 's').executeTool(call({ action: 'list' }))
    expect(result.output).toContain('300 pictures')
    expect(result.output).toContain('300. Webtoon!A2997')
    expect(result.output.split('\n').length).toBeLessThan(260)
  })

  it('reports a workbook without pictures and does not offer the popup', async () => {
    vi.stubGlobal('window', {
      desktopApi: { ocrPictures: vi.fn(async () => ({ ok: true, total: 0, pictures: [] })) },
    })
    const result = await createOcrPicturesSkill(() => 's').executeTool(call({ action: 'list' }))
    expect(result.output).toContain('no pictures')
  })

  it('requests the popup through the bridge and tells the model to stop and wait', async () => {
    const api = stub()
    const result = await createOcrPicturesSkill(() => 'session-1').executeTool(
      call({ action: 'open' }),
    )
    expect(api).toHaveBeenCalledWith({ sessionId: 'session-1', action: 'open' })
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/pictures, formatting and destination/i)
    expect(result.output).toMatch(/confirmed destination without asking again/i)
    expect(result.summary).toBe(zh.aiToolOcrPicturesOpened)
    // the status line shows "waiting for you" until the popup closes
    expect(result.awaitingUser).toBe(true)
  })

  it('does not open the popup while the workbook has unsaved changes and tells the model to offer saving', async () => {
    const api = stub()
    const skill = createOcrPicturesSkill(
      () => 'session-1',
      () => true,
    )
    const result = await skill.executeTool(call({ action: 'open' }))
    expect(api).not.toHaveBeenCalled()
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/unsaved/i)
    expect(result.output).toMatch(/save first/i)
    expect(result.summary).toBe(zh.aiToolOcrPicturesUnsaved)
    expect(result.awaitingUser).toBeFalsy()
    // listing is read-only on the saved file and is not blocked
    expect((await skill.executeTool(call({ action: 'list' }))).output).toContain('5 pictures')
  })

  it('surfaces a refusal and a missing bridge as errors', async () => {
    vi.stubGlobal('window', {
      desktopApi: {
        ocrPictures: vi.fn(async () => ({
          ok: false,
          error: 'Picture OCR needs an .xlsx workbook',
        })),
      },
    })
    const refused = await createOcrPicturesSkill(() => 's').executeTool(call({ action: 'open' }))
    expect(refused.isError).toBe(true)
    expect(refused.output).toContain('.xlsx')
    vi.stubGlobal('window', { desktopApi: {} })
    const missing = await createOcrPicturesSkill(() => 's').executeTool(call({ action: 'list' }))
    expect(missing.isError).toBe(true)
    const noSession = await createOcrPicturesSkill(() => undefined).executeTool(
      call({ action: 'list' }),
    )
    expect(noSession.isError).toBe(true)
  })

  it('reads every confirmed character across pictures and refuses stale workbook results', async () => {
    const dataset = {
      pages: Array.from({ length: 20 }, (_, i) => ({
        index: i + 1,
        location: 'Sheet · A' + (i + 1),
        text: '가'.repeat(i === 0 ? 15999 : 1700) + '😀끝',
      })),
    }
    let session = 'original'
    const skill = createOcrPicturesSkill(
      () => session,
      () => false,
      (id, key) => (id === 'original' && key === 'confirmed' ? dataset : undefined),
    )
    let cursor: { position: number; offset: number } | null = { position: 0, offset: 0 }
    const recovered = new Map<number, string>()
    do {
      const res = await skill.executeTool(
        call({ action: 'read', resultId: 'confirmed', ...cursor }),
      )
      expect(res.isError).toBeFalsy()
      const chunk = JSON.parse(res.output)
      for (const item of chunk.pages) {
        const soFar = recovered.get(item.index) ?? ''
        expect(item.offset).toBe(soFar.length)
        expect(item.text.isWellFormed()).toBe(true)
        recovered.set(item.index, soFar + item.text)
      }
      cursor = chunk.next
    } while (cursor)
    expect([...recovered.values()]).toEqual(dataset.pages.map((p) => p.text))
    session = 'other'
    expect((await skill.executeTool(call({ action: 'read', resultId: 'confirmed' }))).isError).toBe(
      true,
    )
  })

  it('rejects unknown tools and actions', async () => {
    stub()
    const skill = createOcrPicturesSkill(() => 's')
    expect((await skill.executeTool(call({ action: 'list' }, 'other'))).isError).toBe(true)
    expect((await skill.executeTool(call({ action: 'apply' }))).isError).toBe(true)
  })
})

describe('ocr_pictures prompt wording', () => {
  const prompt = String(createOcrPicturesSkill(() => 's').systemPrompt)
  const tool = createOcrPicturesSkill(() => 's').tools?.[0]?.description ?? ''

  it('makes the tool the only path and forbids every manual workaround', () => {
    expect(prompt).toMatch(/only way/i)
    for (const word of ['unzip', 'rename', 'attach', 'save', 'order', 'locate', 'agent window']) {
      expect(prompt.toLowerCase()).toContain(word)
    }
    expect(prompt).toMatch(/never ask the user to (extract|supply)/i)
    expect(prompt).toMatch(/never ask .*(positions|which picture|order)/i)
  })

  it('tells the model to explain briefly, then open the popup, and that nothing is sent first', () => {
    expect(prompt).toMatch(/one or two short sentences/i)
    expect(prompt).toMatch(/picture count/i)
    expect(prompt).toMatch(/nothing is sent/i)
    expect(prompt).toMatch(/confirm/i)
    expect(prompt).toMatch(/unsaved changes/i)
    expect(prompt).not.toMatch(/never tell the person to use a modal or dialog/i)
    expect(tool).toMatch(/popup/i)
  })
})

describe('ocr_pictures in-chat placement flow', () => {
  const prompt = String(createOcrPicturesSkill(() => 's').systemPrompt)

  it('separates formatting from destination in the picker and honors the confirmed cell', () => {
    expect(prompt).toMatch(
      /preserve layout or read plain text independently of the worksheet and cell destination/i,
    )
    expect(prompt).toMatch(/exact sheet and cell without asking again/i)
    expect(prompt).toContain('merge_cells')
  })

  it('decides the placement in the chat with ask_choice, recommended first, reference-only last', () => {
    expect(prompt).toContain('[ocr:result]')
    expect(prompt).toMatch(/ask_choice \(id ocrPlacement/)
    expect(prompt).toMatch(/recommended placement first and marked/i)
    expect(prompt).toMatch(/"Only keep the text as reference \(do not write it\)" last/i)
    expect(prompt).toMatch(/never ask what the sheet layout already answers/i)
  })

  it('follow-up questions cover the webtoon cases and never overwrite silently', () => {
    expect(prompt).toMatch(/one cell per picture or one row per speech bubble/i)
    expect(prompt).toMatch(/sound effects/i)
    expect(prompt).toMatch(/reading order/i)
    expect(prompt).toMatch(/translation column/i)
    expect(prompt).toMatch(/read_cells on every target cell/i)
    expect(prompt).toMatch(/never overwrite[^.]*silently/i)
    expect(prompt).toMatch(/never into source\//i)
    expect(prompt).toMatch(/propose_operations/)
  })

  it('a dismissed popup writes nothing', () => {
    expect(prompt).toMatch(/dismissed[^.]*nothing was read/i)
  })

  it('opening twice reports the popup as already open and keeps waiting', async () => {
    vi.stubGlobal('window', {
      desktopApi: {
        ocrPictures: vi.fn(async () => ({ ok: true, opened: true, alreadyOpen: true })),
      },
    })
    const result = await createOcrPicturesSkill(() => 's').executeTool(call({ action: 'open' }))
    expect(result.output).toMatch(/already open/i)
    expect(result.awaitingUser).toBe(true)
    expect(result.isError).toBeFalsy()
  })
})

describe('ocr_pictures chat lines', () => {
  it('exist in the key set shard', () => {
    for (const key of [
      'aiToolOcrPictures',
      'aiToolOcrPicturesDone',
      'aiToolOcrPicturesOpened',
      'aiToolOcrPicturesUnsaved',
    ] as const) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
    }
  })
})
