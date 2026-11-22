import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { openBatchEditorTools } from '../src/main/translate/batch-editor-tools'
import {
  EDITOR_TOOL_REPLY,
  type EditorToolRequest,
  type EditorToolReply,
} from '@genoffice/project-store/editor-run'

function editor() {
  const frame = {}
  const ipc = new EventEmitter()
  const out: EditorToolRequest[] = []
  const contents = Object.assign(new EventEmitter(), {
    ipc,
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn((_channel: string, command: EditorToolRequest) => out.push(command)),
  })
  const answer = (reply: EditorToolReply, senderFrame = frame) =>
    ipc.emit(EDITOR_TOOL_REPLY, { senderFrame }, reply)
  return { out, contents, wc: contents as unknown as WebContents, ipc, answer }
}
it('binds both the original editor main frame and session and never replays a tool call', async () => {
  const { out, contents, wc, ipc, answer } = editor()
  const opening = openBatchEditorTools(wc, '/work/book.docx', new AbortController().signal)
  const { id, session } = out[0]!
  const describe = {
    kind: 'described',
    id,
    session,
    tools: [],
    systemPrompt: 'current document',
  } as const
  answer({ ...describe, tools: [] }, {})
  expect(out).toHaveLength(1)
  answer({ ...describe, tools: [] })
  const tools = await opening
  const result = tools.executeTool({ id: 'call', name: 'read_runs', input: {} })
  const call = out[1]!
  answer({
    kind: 'result',
    id: call.id,
    session: 'unrelated',
    execution: { output: 'foreign', summary: 'read' },
  })
  answer({
    kind: 'result',
    id: call.id,
    session,
    execution: { output: 'original', summary: 'read' },
  })
  expect(await result).toMatchObject({ output: 'original' })
  contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  expect(out.map((m) => m.kind)).toEqual(['describe', 'execute', 'close'])
  await expect(tools.executeTool({ id: 'again', name: 'read_runs', input: {} })).rejects.toThrow(
    /closed/,
  )
  expect(ipc.listenerCount(EDITOR_TOOL_REPLY)).toBe(0)
})
it('cancels in-flight edits and waits for the renderer to finish before returning', async () => {
  const { out, wc, answer } = editor()
  const abort = new AbortController()
  const opening = openBatchEditorTools(wc, '/work/book.docx', abort.signal)
  const { id, session } = out[0]!
  answer({ kind: 'described', id, session, tools: [], systemPrompt: '' })
  const tools = await opening
  const work = tools.executeTool({ id: 'edit', name: 'translate_blocks', input: {} })
  abort.abort()
  expect(out.at(-1)).toMatchObject({ kind: 'cancel', id: out[1]!.id })
  answer({
    kind: 'result',
    id: out[1]!.id,
    session,
    execution: { output: 'stopped', summary: 'edit' },
  })
  await expect(work).rejects.toThrow()
  tools.close()
})

it('uses private layout checks scoped to the current Word document without exposing model tools', async () => {
  const { out, wc, answer } = editor()
  const opening = openBatchEditorTools(wc, '/work/report.docx', new AbortController().signal)
  const { id, session } = out[0]!
  answer({ kind: 'described', id, session, tools: [], systemPrompt: '' })
  const host = await opening
  expect(host.tools).toEqual([])
  const preparation = host.prepareLayout()
  expect(out.at(-1)).toMatchObject({ kind: 'prepare-layout', path: '/work/report.docx' })
  answer({ kind: 'layout-prepared', id: out.at(-1)!.id, session, needsSave: true })
  expect(await preparation).toBe(true)
  const check = host.reviewLayout()
  expect(out.at(-1)).toMatchObject({ kind: 'review-layout', path: '/work/report.docx' })
  const review = { count: 1, samples: [{ location: 'Block 2 · box 1', text: 'caption' }] }
  answer({ kind: 'layout-reviewed', id: out.at(-1)!.id, session, review })
  expect(await check).toEqual(review)
  const invalid = host.reviewLayout()
  answer({
    kind: 'layout-reviewed',
    id: out.at(-1)!.id,
    session,
    review: { count: 3, samples: [] },
  })
  await expect(invalid).rejects.toThrow('Invalid Word layout results')
  host.close()
})
