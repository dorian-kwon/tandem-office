import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '@genoffice/agent-core'
import { nativeDocumentTools } from '../src/project-document-tools'
import type { AgentSkill } from '@genoffice/agent-core'

const seed = 'Welcome to the walking tour.'
function setup() {
  const stream = vi.fn(() => {
    throw new Error('Unexpected editor AI request')
  })
  const native: AgentSkill = {
    id: 'docs',
    systemPrompt: '',
    buildContext: () => seed,
    tools: ['read_runs', 'translate_blocks', 'replace_blocks', 'generate_image'].map((name) => ({
      name,
      inputSchema: {},
      description: name,
    })),
    executeTool: vi.fn((call) => ({
      output: seed,
      summary: call.name,
      mutated: call.name === 'translate_blocks',
    })),
  }
  const loop = new AgentLoop({
    transport: { stream },
    skill: native,
    documentSkill: native,
    documentTranslation: { documentKey: () => 'test.docx', analyzingLabel: () => 'Reading source' },
  })
  const tools = loop.openDocumentTools((skill, host) => nativeDocumentTools('docs', skill, host))!
  const run = (name: string, input: Record<string, unknown> = {}) =>
    tools.executeTool({ name, id: 'test', input })
  return { loop, native, stream, tools, run }
}

describe('project-owned document tools', () => {
  it('locks competing calls, runs native edits and excludes provider / external tools', async () => {
    const { loop, native, stream, tools, run } = setup()
    expect(
      loop.openDocumentTools((skill, host) => nativeDocumentTools('docs', skill, host)),
    ).toBeNull()
    loop.run('competing document chat')
    expect(await run('generate_image')).toMatchObject({ isError: true })
    expect(
      await run('replace_blocks', {
        startBlockIndex: 0,
        endBlockIndex: 0,
        html: '<p><img src="external"></p>',
      }),
    ).toMatchObject({ isError: true })
    expect(native.executeTool).not.toHaveBeenCalled()
    expect(await run('translate_blocks')).toMatchObject({ mutated: true })
    expect(stream).not.toHaveBeenCalled()
    tools.close()
    expect(loop.busy).toBe(false)
    await expect(run('read_runs')).rejects.toThrow(/ended/)
  })

  it('prepares, verifies source evidence, and supplies continuity without starting a provider', async () => {
    const { run, stream } = setup()
    await run('prepare_document_translation', { targetLanguage: 'Korean' })
    expect(await run('translate_blocks')).toMatchObject({ isError: true })
    await run('read_runs')
    const record = await run('record_source_overview', {
      overview: 'Walking tour guide',
      evidence: 'walking tour',
    })
    expect(record.isError).not.toBe(true)
    expect((await run('translation_batch_context', { source: 'Next route' })).output).toContain(
      'Walking tour guide',
    )
    expect(stream).not.toHaveBeenCalled()
  })
})

it.each([
  ['sheets', 'propose_operations', 'operations', 'set_cell', 'translation', true],
  ['slides', 'apply_ops', 'ops', 'setText', 'translation', true],
  ['html', 'apply_ops', 'ops', 'set_text', 'intent', 'translation'],
  ['markdown', 'apply_ops', 'ops', 'replaceText', 'intent', 'translation'],
  ['epub', 'edit_blocks', 'ops', 'replace', 'intent', 'translation'],
  ['mindmap', 'edit_map', 'edits', 'set_title', 'intent', 'translation'],
] as const)(
  '%s keeps native translation undo and rejects unrelated nested operations',
  async (editor, name, field, op, flag, expected) => {
    const native: AgentSkill = {
      id: editor,
      tools: [{ name, description: 'native', inputSchema: {} }],
      systemPrompt: '',
      executeTool: vi.fn(() => ({ output: 'changed', summary: 'edit', mutated: true })),
    }
    const tools = nativeDocumentTools(editor, native)
    const call = (ops: object[]) => tools.executeTool({ name, id: 'rpc', input: { [field]: ops } })
    expect(await call([{ op }, { op: 'generate_image' }])).toMatchObject({ isError: true })
    expect(native.executeTool).not.toHaveBeenCalled()
    expect(await call([{ op }])).toMatchObject({ mutated: true })
    expect(native.executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ [flag]: expected }) }),
      undefined,
    )
  },
)
