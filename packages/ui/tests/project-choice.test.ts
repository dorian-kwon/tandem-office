import { describe, expect, it, vi } from 'vitest'
import { projectChoiceRemember, CHOICE_REMEMBER_KEYS } from '../src/project-choice'
import { createProjectRun } from '../src/project-skill'
import { contextBundle, fakeProjectBridge } from './project-fake-bridge'

const translationContext = () =>
  contextBundle({ translation: { prompts: 'p', material: '' } })

describe('ProjectRun.translationProject', () => {
  it('is true after a request that carried a translation project, and stays so after finish', async () => {
    const fake = fakeProjectBridge({ context: translationContext() })
    const run = createProjectRun({ bridge: fake.bridge, projectId: () => 'p1' })!
    expect(run.translationProject).toBe(false)
    await run.prepare('x')
    expect(run.translationProject).toBe(true)
    await run.finish()
    expect(run.translationProject).toBe(true)
  })

  it('is false for an ordinary project and when no project is chosen', async () => {
    const fake = fakeProjectBridge()
    let id: string | null = 'p1'
    const run = createProjectRun({ bridge: fake.bridge, projectId: () => id })!
    await run.prepare('x')
    expect(run.translationProject).toBe(false)
    const t = fakeProjectBridge({ context: translationContext() })
    const run2 = createProjectRun({ bridge: t.bridge, projectId: () => id })!
    await run2.prepare('x')
    id = null
    await run2.prepare('x')
    expect(run2.translationProject).toBe(false)
  })
})

describe('projectChoiceRemember', () => {
  const runWith = async (rememberChoice?: ReturnType<typeof vi.fn>, translation = true) => {
    const fake = fakeProjectBridge(translation ? { context: translationContext() } : {})
    const bridge = rememberChoice ? { ...fake.bridge, rememberChoice } : fake.bridge
    const run = createProjectRun({ bridge, projectId: () => 'p1' })!
    await run.prepare('x')
    return run
  }

  it('offers the checkbox only for a keepable key in a translation project with the bridge call', async () => {
    const run = await runWith(vi.fn(async () => ({ ok: true })))
    const host = projectChoiceRemember(() => run)
    for (const key of CHOICE_REMEMBER_KEYS) expect(host.can(key)).toBe(true)
    expect(host.can('projectPrompt')).toBe(false)
    expect(projectChoiceRemember(() => null).can('outputMode')).toBe(false)
    expect(projectChoiceRemember(() => undefined).can('outputMode')).toBe(false)
    const plain = await runWith(vi.fn(async () => ({ ok: true })), false)
    expect(projectChoiceRemember(() => plain).can('outputMode')).toBe(false)
    const noCall = await runWith(undefined)
    expect(projectChoiceRemember(() => noCall).can('outputMode')).toBe(false)
  })

  it('stores the option text or typed text through the bridge, ignoring a refusal or failure', async () => {
    const call = vi.fn(async () => ({ ok: false, reason: 'failed' }))
    const run = await runWith(call)
    const host = projectChoiceRemember(() => run)
    host.store('outputMode', { kind: 'option', index: 2, text: 'Keep the original' }, {
      id: 'q',
      question: 'q',
      options: ['a', 'b'],
      allowTyping: true,
    })
    host.store('bilingual', { kind: 'typed', text: 'in brackets' }, {
      id: 'q',
      question: 'q',
      options: ['a', 'b'],
      allowTyping: true,
    })
    expect(call).toHaveBeenNthCalledWith(1, { key: 'outputMode', value: 'Keep the original' })
    expect(call).toHaveBeenNthCalledWith(2, { key: 'bilingual', value: 'in brackets' })
    const rejecting = await runWith(vi.fn(async () => Promise.reject(new Error('gone'))))
    expect(() =>
      projectChoiceRemember(() => rejecting).store(
        'outputMode',
        { kind: 'typed', text: 'x' },
        { id: 'q', question: 'q', options: ['a', 'b'], allowTyping: true },
      ),
    ).not.toThrow()
  })
})
