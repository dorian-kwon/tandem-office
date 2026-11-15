import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '@genoffice/agent-core'
import { createProjectRun, panelProjectSkill } from '../src/project-skill'
import type { OcrOpenDocument } from '../src/ocr-chat-skill'
import { fakeProjectBridge } from './project-fake-bridge'

/**
 * Apply into the document that is open. When the editor can take the text, the request says so;
 * main answers with what to place and writes nothing; the editor places it. When the editor cannot
 * (or says no), the same apply is made again for a new file, so the reading is never lost.
 */

const PLAN = {
  format: 'docx' as const,
  items: [{ index: 1, text: 'Shop name', part: 'word/document.xml', relId: 'a' }],
  placement: { kind: 'docx-after-images' },
}

function setup(openDocument?: OcrOpenDocument) {
  const fake = fakeProjectBridge()
  const ocr = vi.fn()
  const bridge = { ...fake.bridge, ocr }
  const run = createProjectRun({ bridge, projectId: () => null })!
  const skills = panelProjectSkill({
    run,
    lang: () => 'en',
    ...(openDocument ? { openDocument } : {}),
  })
  return { run, ocr, skill: skills.find((skill) => skill.id === 'document-ocr')! }
}
const apply = (skill: AgentSkill, extra: Record<string, unknown> = {}) =>
  skill.executeTool(
    { id: 'c', name: 'document_ocr', input: { action: 'apply', session: 's1', ...extra } },
    undefined,
  )
const hook = (
  answer: Awaited<ReturnType<OcrOpenDocument['apply']>> = { ok: true, placed: [1], skipped: [] },
) => ({
  unavailableReason: vi.fn((): string | null => null),
  apply: vi.fn(async () => answer),
})

describe('apply into the open document', () => {
  it('asks main for what to place, has the editor place it, and releases the reading', async () => {
    const editor = hook()
    const { run, ocr, skill } = setup(editor)
    await run.prepare()
    ocr.mockResolvedValueOnce({
      output: JSON.stringify({ session: 's1', intoOpenDocument: true }),
      summary: 'OCR',
      placeInDocument: PLAN,
    })
    ocr.mockResolvedValueOnce({ output: '{"cancelled":true}', summary: 'OCR' })

    const result = await apply(skill)

    expect(ocr.mock.calls[0]![0]).toMatchObject({ action: 'apply', intoOpenDocument: true })
    expect(editor.apply).toHaveBeenCalledWith(PLAN)
    expect(ocr.mock.calls[1]![0]).toMatchObject({ action: 'cancel', session: 's1' })
    expect(result.isError).not.toBe(true)
    expect(result.mutated).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({
      placedInOpenDocument: true,
      placed: [1],
      skipped: [],
      saved: false,
    })
  })

  it('tells the model which pictures were left out because they are no longer in the document', async () => {
    const editor = hook({ ok: true, placed: [2], skipped: [1] })
    const { run, ocr, skill } = setup(editor)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{}', summary: 'OCR', placeInDocument: PLAN })
    ocr.mockResolvedValueOnce({ output: '{}', summary: 'OCR' })
    const result = await apply(skill)
    expect(JSON.parse(result.output).skipped).toEqual([1])
  })

  it('writes a new file instead when the editor cannot place it, and says why', async () => {
    const editor = hook({ ok: false, reason: 'the document has tracked changes' })
    const { run, ocr, skill } = setup(editor)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{}', summary: 'OCR', placeInDocument: PLAN })
    ocr.mockResolvedValueOnce({
      output: JSON.stringify({ outputPath: '/p/output/book (OCR).docx' }),
      summary: 'OCR',
      mutated: true,
    })

    const result = await apply(skill)

    expect(ocr.mock.calls[1]![0]).toMatchObject({ action: 'apply' })
    expect(ocr.mock.calls[1]![0]).not.toHaveProperty('intoOpenDocument')
    const body = JSON.parse(result.output)
    expect(body.outputPath).toBe('/p/output/book (OCR).docx')
    expect(body.note).toMatch(/open document.*tracked changes.*new file/i)
  })

  it('writes a new file instead when the editor throws', async () => {
    const editor = {
      unavailableReason: () => null,
      apply: vi.fn(async () => Promise.reject(new Error('boom'))),
    }
    const { run, ocr, skill } = setup(editor as never)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{}', summary: 'OCR', placeInDocument: PLAN })
    ocr.mockResolvedValueOnce({ output: '{"outputPath":"/x.docx"}', summary: 'OCR' })
    const result = await apply(skill)
    expect(JSON.parse(result.output).outputPath).toBe('/x.docx')
    expect(result.output).not.toContain('boom')
  })

  it('writes a new file and says why when the document on screen cannot take it', async () => {
    const editor = {
      unavailableReason: vi.fn(() => 'it is read-only (a source copy)'),
      apply: vi.fn(),
    }
    const { run, ocr, skill } = setup(editor as never)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{"outputPath":"/x.docx"}', summary: 'OCR' })
    const result = await apply(skill)
    expect(ocr.mock.calls[0]![0]).not.toHaveProperty('intoOpenDocument')
    expect(editor.apply).not.toHaveBeenCalled()
    const body = JSON.parse(result.output)
    expect(body.outputPath).toBe('/x.docx')
    expect(body.note).toMatch(/new file.*cannot take it now.*read-only/i)
  })

  it('adds no note to a refusal, which is not a file that was written', async () => {
    const editor = { unavailableReason: () => 'it is read-only', apply: vi.fn() }
    const { run, ocr, skill } = setup(editor as never)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{"error":"no"}', summary: 'OCR', isError: true })
    const result = await apply(skill)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ error: 'no' })
  })

  it('never asks for it from an editor that has no such hook', async () => {
    const { run, ocr, skill } = setup()
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{"outputPath":"/x.docx"}', summary: 'OCR' })
    await apply(skill)
    expect(ocr.mock.calls[0]![0]).not.toHaveProperty('intoOpenDocument')
  })

  it('returns the answer as it is when main wrote a file or refused', async () => {
    const editor = hook()
    const { run, ocr, skill } = setup(editor)
    await run.prepare()
    ocr.mockResolvedValueOnce({ output: '{"error":"no"}', summary: 'OCR', isError: true })
    const refused = await apply(skill)
    expect(refused.isError).toBe(true)
    expect(editor.apply).not.toHaveBeenCalled()
    ocr.mockResolvedValueOnce({ output: '{"outputPath":"/x.docx"}', summary: 'OCR' })
    expect(JSON.parse((await apply(skill)).output).outputPath).toBe('/x.docx')
    expect(editor.apply).not.toHaveBeenCalled()
  })

  it('does not put the flag on any other action', async () => {
    const editor = hook()
    const { run, ocr, skill } = setup(editor)
    await run.prepare()
    ocr.mockResolvedValue({ output: '{}', summary: 'OCR' })
    await skill.executeTool(
      { id: 'c', name: 'document_ocr', input: { action: 'propose', session: 's1' } },
      undefined,
    )
    expect(ocr.mock.calls[0]![0]).not.toHaveProperty('intoOpenDocument')
  })

  it('tells the model what to say after the text went into the open document', async () => {
    const { run, skill } = setup(hook())
    await run.prepare()
    expect(skill.systemPrompt).toMatch(/placedInOpenDocument.*not saved.*Ctrl\+S.*Ctrl\+Z/is)
  })
})
