import { describe, expect, it, vi } from 'vitest'
import type { AgentSkill } from '@genoffice/agent-core'
import { createProjectRun, panelProjectSkill } from '../src/project-skill'
import { fakeProjectBridge } from './project-fake-bridge'

function setup(projectId: string | null = null) {
  const fake = fakeProjectBridge()
  const ocr = vi.fn().mockResolvedValue({ output: 'Inspected', summary: 'OCR' })
  const bridge = { ...fake.bridge, ocr }
  const run = createProjectRun({ bridge, projectId: () => projectId })!
  const skills = panelProjectSkill({ run, lang: () => 'en' })
  return { fake, ocr, run, skill: skills.find((skill) => skill.id === 'document-ocr')! }
}

function execute(skill: AgentSkill, input: Record<string, unknown>, signal?: AbortSignal) {
  return skill.executeTool({ id: 'call-1', name: 'document_ocr', input }, signal)
}

describe('conversational document OCR', () => {
  it('is left out when the editor has its own OCR path (ocrChat: false)', () => {
    const fake = fakeProjectBridge()
    const bridge = { ...fake.bridge, ocr: vi.fn() }
    const run = createProjectRun({ bridge, projectId: () => null })!
    const ids = (opts: { ocrChat?: boolean }) =>
      panelProjectSkill({ run, lang: () => 'en', ...opts }).map((skill) => skill.id)
    expect(ids({})).toContain('document-ocr')
    expect(ids({ ocrChat: false })).not.toContain('document-ocr')
  })

  it('is available without a selected project after prepare and mints one id per human turn', async () => {
    const { run, skill, fake } = setup()
    expect(skill).toBeDefined()
    expect(skill.tools).toEqual([])
    expect(run.turnId).toBeUndefined()
    await run.prepare()
    const first = run.turnId
    expect(first).toMatch(/^[\da-f-]{36}$/i)
    expect(skill.tools.map((tool) => tool.name)).toEqual(['document_ocr'])
    expect(run.turnId).toBe(first)
    expect(fake.bridge.openScope).not.toHaveBeenCalled()
    await run.finish()
    expect(run.turnId).toBeUndefined()
    expect(skill.tools).toEqual([])
    await run.prepare()
    expect(run.turnId).not.toBe(first)
  })

  it('teaches chat scope, selection, review and later confirmation without dialogs', async () => {
    const { run, skill } = setup()
    await run.prepare()
    expect(skill.systemPrompt).toMatch(/inspect.*first/i)
    // the scope is chosen in the popup, never asked in the chat
    expect(skill.systemPrompt).toMatch(/not ask.*whole document.*popup/is)
    expect(skill.systemPrompt).not.toMatch(/Ask in this chat whether/)
    expect(skill.systemPrompt).toMatch(/list.*only.*request/i)
    expect(skill.systemPrompt).toMatch(/read.*explicit.*select/i)
    expect(skill.systemPrompt).toMatch(/read.*never writes/i)
    expect(skill.systemPrompt).toMatch(/propose.*location.*reason/i)
    expect(skill.systemPrompt).toMatch(/apply.*explicit confirmation.*later human turn/i)
    expect(skill.systemPrompt).toMatch(/DOCX.*XLSX/)
    expect(skill.systemPrompt).toMatch(/never tell.*other dialog/is)
    // the placement question goes through the shared numbered card, never prose
    expect(skill.systemPrompt).toMatch(/ask_choice.*ocrPlacement/s)
    // the options are the person's to choose between: none is marked recommended
    expect(skill.systemPrompt).toMatch(/do not mark any of them as recommended/i)
    expect(skill.systemPrompt).not.toMatch(/marked as recommended|recommended placement first/i)
    expect(skill.systemPrompt).toMatch(/reference.*cancel.*do not apply/is)
    const schema = skill.tools[0]!.inputSchema
    expect(schema.properties).not.toHaveProperty('turnId')
    expect(schema.properties).not.toHaveProperty('requestId')
    expect(schema.properties).not.toHaveProperty('scope')
  })

  it('teaches the formats that end in a new Word document and the old .doc', async () => {
    const { run, skill } = setup()
    await run.prepare()
    // a PDF and a Hangul document: no placement question, a plain confirmation instead
    expect(skill.systemPrompt).toMatch(/PDF.*Hangul.*new Word document/s)
    expect(skill.systemPrompt).toMatch(/new-docx.*no placement/s)
    expect(skill.systemPrompt).toMatch(/do not ask the ocrPlacement question/i)
    // an old .doc is not read
    expect(skill.systemPrompt).toMatch(/\.doc is not read.*save it as \.docx/s)
  })

  it('does not tell the person how the pictures were read: it goes straight to where the text goes', async () => {
    const { run, skill } = setup()
    await run.prepare()
    // no summary, quote or review of the recognised text, whatever was picked
    expect(skill.systemPrompt).toMatch(
      /do not review, quote, summarize or describe the recognised text/i,
    )
    expect(skill.systemPrompt).not.toMatch(/Review the transcription with the person/)
    expect(skill.systemPrompt).not.toMatch(/once the person has reviewed the text/i)
    // propose right after the reading, and ask only the placement
    expect(skill.systemPrompt).toMatch(
      /call propose in the same turn and ask only where the text goes/i,
    )
    // the text is shown only when the person asks for it
    expect(skill.systemPrompt).toMatch(/use review only when the person asks to see the text/i)
    // a PDF or a Hangul document: one short sentence and a plain confirmation, no text
    expect(skill.systemPrompt).toMatch(
      /one short sentence.*new Word document.*do not show the text/is,
    )
  })

  it('opens the popup right after inspect, in the same turn, without asking about scope first', async () => {
    const { run, skill } = setup()
    await run.prepare()
    expect(skill.systemPrompt).toMatch(/inspect first.*then call choose in the same turn/is)
    expect(skill.systemPrompt).toMatch(/offers the whole document or a selection/i)
    // after the popup only the placement is asked, as the numbered card
    expect(skill.systemPrompt).toMatch(/ask_choice.*ocrPlacement/s)
  })

  it('lets the person look at the pictures and choose in a popup instead of typing numbers', async () => {
    const { run, skill } = setup()
    await run.prepare()
    expect(skill.systemPrompt).toMatch(/call choose/i)
    expect(skill.systemPrompt).toMatch(/popup.*document order.*page/is)
    expect(skill.systemPrompt).toMatch(/not ask for picture numbers/i)
    // what the person confirmed there is not asked again in the chat
    expect(skill.systemPrompt).toMatch(/already confirmed.*propose in the same turn/is)
    const schema = skill.tools[0]!.inputSchema as { properties: { action: { enum: string[] } } }
    expect(schema.properties.action.enum).toContain('choose')
  })

  it('lists the text boxes over the picture first, without calling them recommended', async () => {
    const { run, skill } = setup()
    await run.prepare()
    expect(skill.systemPrompt).toMatch(
      /text boxes over the picture when the result's reason is on-picture/i,
    )
    // the way that was not proposed first stays an option
    expect(skill.systemPrompt).toMatch(/alternatives/i)
    // and the placement of the recommendation is passed on to apply as it is
    expect(skill.systemPrompt).toMatch(/docx-image-boxes.*as it is/is)
  })

  it('injects trusted turn, scope and request identifiers and forwards the real result', async () => {
    const { run, skill, ocr } = setup('p1')
    await run.prepare()
    const answer = {
      output: 'Applied',
      summary: 'OCR inserted',
      mutated: true,
      display: { kind: 'images', items: [{ url: 'data:image/png;base64,YQ==', title: 'Image 1' }] },
    }
    ocr.mockResolvedValueOnce(answer)
    expect(
      await execute(skill, {
        action: 'apply',
        session: 'session-1',
        placement: { mode: 'after' },
        turnId: 'forged',
        requestId: 'forged',
        scope: 'forged',
      }),
    ).toEqual(answer)
    expect(ocr).toHaveBeenCalledWith({
      action: 'apply',
      session: 'session-1',
      placement: { mode: 'after' },
      turnId: run.turnId,
      scope: run.snapshot!.scope,
      requestId: expect.any(String),
    })
    expect(ocr.mock.calls[0]![0].requestId).not.toBe('forged')
  })

  it('sends cancellation with the original request id and keeps the main failure', async () => {
    const { run, skill, ocr } = setup()
    await run.prepare()
    let complete!: (answer: unknown) => void
    ocr.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    )
    const controller = new AbortController()
    const result = execute(skill, { action: 'read', session: 's', pages: [1] }, controller.signal)
    const request = ocr.mock.calls[0]![0]
    controller.abort()
    expect(ocr).toHaveBeenLastCalledWith({
      action: 'cancel',
      turnId: request.turnId,
      requestId: request.requestId,
    })
    const failed = { output: 'Cancelled by main', summary: 'Stopped', isError: true }
    complete(failed)
    expect(await result).toEqual(failed)
    expect(ocr).toHaveBeenCalledTimes(2)
  })

  it('does not start OCR with an already aborted signal or without a prepared run', async () => {
    const { run, skill, ocr } = setup()
    expect((await execute(skill, { action: 'inspect' })).isError).toBe(true)
    await run.prepare()
    const controller = new AbortController()
    controller.abort()
    expect((await execute(skill, { action: 'read' }, controller.signal)).isError).toBe(true)
    expect(ocr).not.toHaveBeenCalled()
  })

  it('forwards selected images, pagination and recommendation edits without trusted model fields', async () => {
    const { run, skill, ocr } = setup()
    await run.prepare()
    for (const input of [
      { action: 'list', session: 's', offset: 10, limit: 5 },
      { action: 'read', file: 'source.docx', session: 's', pages: [2, 4], all: false },
      {
        action: 'propose',
        session: 's',
        placement: { location: 'Sheet1!B2', reason: 'confirmed location' },
        texts: [{ index: 2, text: 'The corrected translation requested by the person.' }],
      },
    ]) {
      await execute(skill, input)
      expect(ocr).toHaveBeenLastCalledWith({
        ...input,
        turnId: run.turnId,
        requestId: expect.any(String),
      })
    }
  })

  it('removes the abort handler after completion and reports transport failures', async () => {
    const { run, skill, ocr } = setup()
    await run.prepare()
    const controller = new AbortController()
    await execute(skill, { action: 'inspect' }, controller.signal)
    controller.abort()
    expect(ocr).toHaveBeenCalledTimes(1)
    ocr.mockRejectedValueOnce(new Error('offline'))
    const failed = await execute(skill, { action: 'inspect' })
    expect(failed.isError).toBe(true)
    expect(failed.mutated).not.toBe(true)
  })

  it('rejects unknown actions and preserves backend refusals', async () => {
    const { run, skill, ocr } = setup()
    await run.prepare()
    expect((await execute(skill, { action: 'write' })).isError).toBe(true)
    expect(ocr).not.toHaveBeenCalled()
    const refused = {
      output: 'Select images on a later human turn.',
      summary: 'OCR refused',
      isError: true,
    }
    ocr.mockResolvedValueOnce(refused)
    expect(await execute(skill, { action: 'read', pages: [1] })).toEqual(refused)
  })
})
