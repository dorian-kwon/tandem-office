import { describe, expect, it, vi } from 'vitest'
import { documentTranslationSkill } from '../src/document-translation'
import { addressInConversation } from '../src/outbound-guard'
import { AgentLoop } from '../src/loop'
import type { AgentStreamRequest, AgentToolCall } from '../src/types'
import type { AgentSkill } from '../src/skill'

function setup(read = 'For the incoming volunteers. Welcome!\n팸투어') {
  let key = 'one'
  const editor: AgentSkill = {
    id: 'doc',
    tools: ['read_blocks', 'apply_ops', 'project_read'].map((name) => ({
      name,
      description: '',
      inputSchema: {},
    })),
    systemPrompt: 'native prompt',
    executeTool: vi.fn((call) => ({ output: read, summary: call.name })),
  }
  const { skill, reset, restore } = documentTranslationSkill(editor, {
    documentKey: () => key,
    analyzingLabel: () => '원문 파악 중',
  })
  const call = (name: string, input = {}) => skill.executeTool({ id: '1', name, input })
  const begin = (targetLanguage = 'en') => call('prepare_document_translation', { targetLanguage })
  const record = (extra = {}) =>
    call('record_source_overview', {
      overview: 'Volunteer welcome guide',
      evidence: 'Welcome!',
      ...extra,
    })
  return {
    editor,
    skill,
    reset,
    restore,
    call,
    begin,
    record,
    changeContent: (content: string) => {
      read = content
    },
    switchDoc: () => {
      key = 'two'
    },
  }
}

describe('whole document translation in editor chat', () => {
  it('reads native source before writing and verifies optional reader and purpose quotes', async () => {
    const { begin, call, record, skill, editor } = setup()
    expect(skill.tools.map((t) => t.name)).toContain('apply_ops')
    expect((await begin()).summary).toBe('원문 파악 중')
    expect(skill.tools.map((t) => t.name)).toEqual(['read_blocks', 'record_source_overview'])
    expect((await record()).isError).toBe(true)
    expect((await call('apply_ops')).isError).toBe(true)
    expect((await call('project_read')).isError).toBe(true)
    expect(editor.executeTool).not.toHaveBeenCalled()
    await call('read_blocks')
    expect((await record({ audienceQuote: 'Students' })).isError).toBe(true)
    expect((await record({ purposeQuote: 'Research' })).isError).toBe(true)
    expect((await record({ audienceQuote: 'incoming volunteers' })).isError).toBeFalsy()
    expect(skill.tools.map((t) => t.name)).toContain('apply_ops')
    expect(editor.executeTool).toHaveBeenCalledTimes(1)
  })

  it('recalls the preceding translation and distant matching terms and leaves ordinary follow-ups alone', async () => {
    const { begin, call, record, skill, changeContent } = setup()
    await begin()
    await call('read_blocks')
    await record()
    const lookup = (source: string, more = {}) =>
      call('translation_batch_context', { source, ...more })
    changeContent('Welcome!\nFAM tour\nFirst batch ending')
    await call('read_blocks')
    await lookup('next', {
      previous: 'First batch ending',
      pairs: [{ source: '팸투어', target: 'FAM tour' }],
    })
    for (let i = 0; i < 22; i++) {
      changeContent('Welcome!\nFAM tour\nending ' + i)
      await call('read_blocks')
      await lookup('unrelated', { previous: 'ending ' + i })
    }
    const output = JSON.parse((await lookup('팸투어 일정')).output)
    expect(output.previous).toBe('ending 21')
    expect(output.matches).toEqual([['팸투어', 'FAM tour']])
    skill.buildContext!()
    expect(skill.tools.map((t) => t.name)).not.toContain('record_source_overview')
    await call('apply_ops')
    expect((await begin()).output).toContain('Volunteer welcome guide')
    skill.buildContext!()
    await begin('ja')
    expect(JSON.parse((await lookup('팸투어')).output).matches).toEqual([])
  })

  it('clears both notes and wording when the document or conversation changes', async () => {
    const { begin, call, record, skill, reset, switchDoc } = setup()
    for (const change of [switchDoc, reset]) {
      await begin()
      await call('read_blocks')
      await record()
      change()
      skill.buildContext!()
      expect((await begin()).output).not.toContain('Volunteer welcome guide')
      expect(skill.tools.map((t) => t.name)).toContain('record_source_overview')
      skill.buildContext!()
    }
  })

  it('never uses an address from a model-authored translation note as approval to fetch it', () => {
    for (const name of [
      'prepare_document_translation',
      'record_source_overview',
      'translation_batch_context',
    ])
      expect(
        addressInConversation('https://untrusted.test', [
          { role: 'tool', results: [{ id: '1', name, output: 'https://untrusted.test' }] },
        ]),
      ).toBe(false)
  })
})

it('restores successful local tool records for the same file, ignores a different file and refreshes only by explicit request', async () => {
  const first = setup()
  await first.begin()
  await first.call('read_blocks')
  const overview = await first.record()
  first.changeContent('Welcome! Last line FAM tour')
  await first.call('read_blocks')
  const batch = await first.call('translation_batch_context', {
    source: 'next',
    previous: 'Last line',
    pairs: [{ source: '팸투어', target: 'FAM tour' }],
  })
  const persisted = [
    {
      role: 'assistant',
      tools: [
        { name: 'record_source_overview', output: overview.historyOutput },
        { name: 'translation_batch_context', output: batch.historyOutput },
      ],
    },
  ]
  expect(overview.historyOutput).toBeTruthy()
  expect(overview.output).not.toContain(JSON.parse(overview.historyOutput!).doc)
  const next = setup('Welcome! Last line FAM tour')
  next.restore(persisted)
  expect((await next.begin()).output).toContain('Volunteer welcome guide')
  expect(
    JSON.parse((await next.call('translation_batch_context', { source: '팸투어' })).output),
  ).toMatchObject({ previous: 'Last line', matches: [['팸투어', 'FAM tour']] })
  next.skill.buildContext!()
  await next.call('prepare_document_translation', { targetLanguage: 'en', refresh: true })
  expect(next.skill.tools.map((t) => t.name)).toContain('record_source_overview')
  const different = setup()
  different.switchDoc()
  different.skill.buildContext!()
  different.restore(persisted)
  expect((await different.begin()).output).not.toContain('Volunteer welcome guide')
})

it('rechecks the original locations and drops an old translation after an Undo, manual edit or same-path source replacement', async () => {
  const { begin, call, record, changeContent, skill } = setup('Welcome!\nSecond chapter\n팸투어')
  await begin()
  await call('read_blocks')
  await record({ otherEvidence: ['Second chapter'] })
  changeContent('Welcome!\nSecond chapter\nFAM tour')
  await call('read_blocks')
  const first = await call('translation_batch_context', {
    source: '팸투어',
    previous: 'FAM tour',
    pairs: [{ source: '팸투어', target: 'FAM tour' }],
  })
  expect(JSON.parse(first.output).matches).toEqual([['팸투어', 'FAM tour']])
  changeContent('Edited greeting\nSecond chapter\nFam tour')
  skill.buildContext!()
  expect((await begin()).output).toContain('Volunteer welcome guide')
  const afterEdit = JSON.parse(
    (await call('translation_batch_context', { source: '팸투어' })).output,
  )
  expect(afterEdit.matches).toEqual([])
  expect(afterEdit.previous).toBe('')
  changeContent('A completely different report')
  skill.buildContext!()
  expect((await begin()).output).not.toContain('Volunteer welcome guide')
  expect(skill.tools.map((t) => t.name)).toContain('record_source_overview')
})

it('drops a changed audience quote without rebuilding an otherwise grounded overview', async () => {
  const { begin, call, record, skill, changeContent } = setup('Welcome!\nFor students')
  await begin()
  await call('read_blocks')
  await record({ audienceQuote: 'For students' })
  skill.buildContext!()
  changeContent('Welcome!\nFor parents')
  const resumed = await begin()
  expect(resumed.output).toContain('Volunteer welcome guide')
  expect(resumed.output).not.toContain('For students')
})

it('stages native editing in the real loop and sends the local restoration record only to activity history', async () => {
  const requests: AgentStreamRequest[] = []
  const local: string[] = []
  const script: AgentToolCall[] = [
    { id: 'start', name: 'prepare_document_translation', input: { targetLanguage: 'en' } },
    { id: 'read', name: 'read_blocks', input: {} },
    {
      id: 'outline',
      name: 'record_source_overview',
      input: { overview: 'A welcome guide', evidence: 'Welcome!' },
    },
    { id: 'apply', name: 'apply_ops', input: {} },
  ]
  let done!: () => void
  let fail!: (err: string) => void
  const completion = new Promise<void>((resolve, reject) => {
    done = resolve
    fail = reject
  })
  const loop = new AgentLoop({
    skill: setup().editor,
    documentTranslation: { documentKey: () => '/test/guide', analyzingLabel: () => '원문 파악 중' },
    transport: {
      stream(request, callbacks) {
        requests.push(request)
        const next = script.shift()
        queueMicrotask(() => {
          if (next) callbacks.onToolCall(next)
          else callbacks.onDelta('Finished')
          callbacks.onDone()
        })
        return { cancel: () => {} }
      },
    },
    events: {
      onToolExecuted: ({ call, execution }) => {
        if (call.name === 'record_source_overview') local.push(execution.output)
      },
      onDone: done,
      onError: fail,
    },
  })
  loop.run('Translate the whole guide.')
  await completion
  const available = requests.map((r) => r.tools.map((t) => t.name))
  expect(available[1]).not.toContain('apply_ops')
  expect(available[2]).toContain('record_source_overview')
  expect(available[3]).toContain('apply_ops')
  const saved = JSON.parse(local[0]!)
  expect(saved.doc).toMatch(/^[0-9a-f]{64}$/)
  expect(JSON.stringify(requests)).not.toContain(saved.doc)
  expect(JSON.stringify(requests)).not.toContain('/test/guide')
})
