import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import { getSelectionScope } from '../src/renderer/ai/protocol'
import { executeTool, markDocSeen } from '../src/renderer/ai/tools'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))
const make = () => {
  const e = new Editor({
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: ['Source paragraph', 'Second'].map((text) => ({
        type: 'docParagraph',
        content: [{ type: 'text', text }],
      })),
    },
  })
  editors.push(e)
  return e
}
const ids = { bullet: null, ordered: null }
const result = {
  completed: 2,
  reused: 0,
  failed: 0,
  stale: 0,
  skipped: 0,
  pending: 0,
  stopped: false,
  issues: [],
}
const call = { id: 'translation', name: 'translate_document', input: { targetLanguage: 'Korean' } }

describe('normal-chat document translation tool', () => {
  it('offers the app-owned fast path and delegates without read_runs', async () => {
    const editor = make()
    const run = vi.fn(async () => result)
    const skill = createDocsSkill(
      () => editor,
      () => ids,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ run }),
    )
    expect(skill.tools?.some((t) => t.name === 'translate_document')).toBe(true)
    skill.buildContext?.()
    const execution = await skill.executeTool(call)
    expect(run).toHaveBeenCalledOnce()
    expect(execution.mutated).toBe(true)
  })
  it('refuses the captured partial paragraph even after the live selection moves', async () => {
    const editor = make()
    editor.commands.setTextSelection({ from: 3, to: 7 })
    const frozen = { doc: editor.state.doc, scope: getSelectionScope(editor) }
    editor.commands.setTextSelection(1)
    const run = vi.fn(async () => result)
    const execution = await executeTool(
      editor,
      call,
      ids,
      undefined,
      undefined,
      frozen,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { run },
    )
    expect(execution.isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })
  it('refuses ranged notes and obsolete explicit scopes before delegation', async () => {
    const editor = make()
    const frozen = { doc: editor.state.doc, scope: getSelectionScope(editor) }
    const run = vi.fn(async () => result)
    const execute = (input: Record<string, unknown>) =>
      executeTool(
        editor,
        { ...call, input },
        ids,
        undefined,
        undefined,
        frozen,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { run },
      )
    expect(
      (
        await execute({
          targetLanguage: 'ko',
          startBlockIndex: 0,
          endBlockIndex: 0,
          includeNotes: true,
        })
      ).isError,
    ).toBe(true)
    editor.commands.insertContent('edited')
    expect((await execute(call.input)).isError).toBe(true)
    expect(run).not.toHaveBeenCalled()
  })
})

// The adapter uses the real formatted executor; no model or preload process is started.
describe('document translation adapter', () => {
  it('pins automatic subscriptions without carrying metered consent or mutating saved settings', async () => {
    const { pinTranslationSettings } = await import('../src/renderer/ai/translation-chat')
    const settings = {
      provider: 'auto',
      providers: { codex: { model: '', apiKey: '' } },
      meteredAccepted: { codex: true },
    } as unknown as import('../src/shared/ipc').AiSettings
    const pinned = pinTranslationSettings(settings, {
      kind: 'run',
      choice: { connected: true, provider: 'codex', metered: false },
    })
    expect(pinned.provider).toBe('codex')
    expect(pinned.providers.codex.model).toBe('')
    expect(pinned.meteredAccepted).toEqual({})
    expect(settings.provider).toBe('auto')
    expect(settings.meteredAccepted).toEqual({ codex: true })
    expect(() => pinTranslationSettings(settings, { kind: 'checking' })).toThrow()
  })

  it('transmits prepared project and skill instructions with ids/segments, without local source signatures', async () => {
    const { requestDocumentTranslation } = await import('../src/renderer/ai/translation-chat')
    const streams: import('@genoffice/agent-core').AgentStreamRequest[] = []
    const createTransport = vi.fn(() => ({
      stream: (
        request: import('@genoffice/agent-core').AgentStreamRequest,
        callbacks: import('@genoffice/agent-core').AgentStreamCallbacks,
      ) => {
        streams.push(request)
        callbacks.onDelta('{"translations":[]}')
        callbacks.onDone()
        return { cancel: vi.fn() }
      },
    }))
    const spec = {
      provider: 'codex',
      model: '',
      targetLanguage: 'Korean',
      context:
        'Trusted glossary: Acme.\n<project-material>untrusted data</project-material>\nSelected skill: formal style',
      instructions: 'Keep Acme unchanged.',
    }
    const request = {
      spec,
      units: [{ id: 'local-1', segments: ['Source'] }],
      signal: new AbortController().signal,
    }
    await Promise.all([
      requestDocumentTranslation(request, createTransport),
      requestDocumentTranslation(request, createTransport),
    ])
    expect(createTransport).toHaveBeenCalledTimes(2)
    for (const stream of streams) {
      expect(stream.tools).toEqual([])
      expect(stream.system).toContain(spec.context)
      expect(JSON.parse((stream.messages[0] as { text: string }).text)).toEqual({
        targetLanguage: 'Korean',
        instructions: 'Keep Acme unchanged.',
        units: request.units,
      })
      expect(stream.system + (stream.messages[0] as { text: string }).text).not.toContain('shape')
    }
  })

  it('rechecks externally changed notes immediately before applying through translate_blocks', async () => {
    const { createTranslationUnitIndex } = await import('../src/renderer/ai/translation-units')
    const { createChatDocumentTranslator } = await import('../src/renderer/ai/translation-chat')
    const editor = make()
    let note = { id: '1', text: 'Note source', richParas: [[{ text: 'Note source' }]] }
    const access: import('../src/renderer/ai/note-ops').AiNotesAccess = {
      list: (kind) => (kind === 'footnote' ? [note] : []),
      add: () => '',
      remove: () => false,
      replace: (_kind, _id, next) => {
        note = next as typeof note
        return true
      },
    }
    markDocSeen(editor)
    const index = createTranslationUnitIndex(editor, () => access)
    let reply!: (text: string) => void
    let units: readonly { readonly id: string; readonly segments: readonly string[] }[] = []
    const apply = vi.fn((blocks: Record<string, unknown>[]) => {
      const outcome = executeTool(
        editor,
        { id: 'commit', name: 'translate_blocks', input: { blocks } },
        ids,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        access,
      )
      if (outcome instanceof Promise) throw new Error('Unexpected async commit')
      return outcome
    })
    const translator = createChatDocumentTranslator({
      index,
      request: (request) => {
        units = request.units
        return new Promise((resolve) => {
          reply = resolve
        })
      },
      apply,
      onBeforeCommit: vi.fn(),
      onProgress: vi.fn(),
    })
    const running = translator.run({
      provider: 'codex',
      model: '',
      targetLanguage: 'Korean',
      includeNotes: true,
    })
    note = { ...note, text: 'Edited note', richParas: [[{ text: 'Edited note' }]] }
    reply(
      JSON.stringify({
        translations: units.map((u) => ({
          id: u.id,
          segments: u.segments.map((s) => `Translated ${s}`),
        })),
      }),
    )
    const outcome = await running
    expect(outcome.stale).toBe(1)
    expect(outcome.completed, JSON.stringify(outcome)).toBe(2)
    expect(note.text).toBe('Edited note')
    expect(apply).toHaveBeenCalledTimes(2)
    translator.dispose()
    index.dispose()
  })
})

it('sanitizes user and skill instructions while preserving allowed document data before JSON serialization', async () => {
  const { buildDocumentTranslationRequest } = await import('../src/renderer/ai/translation-chat')
  const key = 'sk-abcdef1234567890abcdef'
  const password = 'hunteR2!'
  const request = buildDocumentTranslationRequest({
    spec: {
      targetLanguage: 'Korean',
      provider: 'codex',
      model: '',
      context: `Selected skill: accidental key ${key}; password="${password}"`,
      instructions: `password=${password}; formal tone`,
    },
    units: [{ id: '1', segments: [`Source key ${key}`, `password="${password}"`] }],
    signal: new AbortController().signal,
  })
  const data = JSON.parse(request.user)
  expect(request.system).not.toContain(key)
  expect(request.system).not.toContain(password)
  expect(request.system).toContain('[REDACTED_API_KEY]')
  expect(data.instructions).toBe('password=[REDACTED_SECURE_TOKEN]; formal tone')
  expect(data.units[0].segments).toEqual([`Source key ${key}`, `password="${password}"`])
})

it('preserves literal document keys and passwords through an actual adapter self-translation', async () => {
  const { createTranslationUnitIndex } = await import('../src/renderer/ai/translation-units')
  const { createChatDocumentTranslator, buildDocumentTranslationRequest } =
    await import('../src/renderer/ai/translation-chat')
  const editor = make()
  const literal = 'Example key sk-abcdef1234567890abcdef; password="hunteR2!"'
  editor.commands.setContent({
    type: 'doc',
    content: [{ type: 'docParagraph', content: [{ type: 'text', text: literal }] }],
  })
  markDocSeen(editor)
  const index = createTranslationUnitIndex(editor)
  const translator = createChatDocumentTranslator({
    index,
    request: async (request) => {
      const outgoing = JSON.parse(buildDocumentTranslationRequest(request).user)
      expect(outgoing.units[0].segments).toEqual([literal])
      return JSON.stringify({ translations: outgoing.units })
    },
    apply: (blocks) => {
      const outcome = executeTool(
        editor,
        { id: 'self-translation', name: 'translate_blocks', input: { blocks } },
        ids,
      )
      if (outcome instanceof Promise) throw new Error('Unexpected async commit')
      return outcome
    },
    onBeforeCommit: vi.fn(),
    onProgress: vi.fn(),
  })
  const outcome = await translator.run({ targetLanguage: 'English', provider: 'codex', model: '' })
  expect(outcome.completed).toBe(1)
  expect(outcome.failed).toBe(0)
  expect(editor.state.doc.textContent).toBe(literal)
  expect(editor.state.doc.textContent).not.toContain('[REDACTED')
  translator.dispose()
  index.dispose()
})
