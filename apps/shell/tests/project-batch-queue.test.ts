import { expect, it, vi } from 'vitest'
import { BatchTranslationNeedsReview } from '../src/main/translate/batch-completion'
import { ProjectBatchQueue } from '../src/main/translate/project-batch'

const dir = '/project'
const owner = 7
function gate() {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
function harness() {
  let settled = gate()
  const queue = new ProjectBatchQueue((state) => {
    if (!state.running) {
      settled.release()
      settled = gate()
    }
  })
  return { queue, done: () => settled.wait }
}

it('retains a final source verification through saving and invalidates it on an ordinary edit', async () => {
  const { queue, done } = harness()
  const settled = done()
  queue.start(
    dir,
    ['empty', 'edit', 'unfinished', 'reported'],
    owner,
    async (file, signal, report) => {
      expect(signal.aborted).toBe(false)
      if (file === 'empty') {
        report({ phase: 'translating' })
        report({ verified: true, done: 0, total: 0 })
      }
      if (file === 'edit') {
        report({ phase: 'translating', verified: true, done: 3, total: 3 })
        report({ operations: 1 })
      }
      if (file === 'unfinished') report({ phase: 'translating', verified: true, done: 1, total: 3 })
      if (file === 'reported') report({ phase: 'translating', done: 0, total: 0 })
      report({ phase: 'saving' })
      return file + '.docx'
    },
    false,
  )
  await settled
  const [empty, edit, unfinished, reported] = queue.status(dir)!.items
  expect(empty).toMatchObject({ state: 'saved', verified: true, done: 0, total: 0 })
  expect(edit).not.toHaveProperty('verified')
  expect(edit).not.toHaveProperty('total')
  expect(unfinished).not.toHaveProperty('verified')
  expect(unfinished).toMatchObject({ done: 1, total: 3 })
  expect(reported).not.toHaveProperty('total')
})

it('delivers each original turn once after all selected translations settle, with one contextual reply', async () => {
  const { queue, done } = harness()
  const first = gate()
  const second = gate()
  const third = gate()
  const running = done()
  const snap = queue.start(
    dir,
    ['one', 'two', 'three'],
    owner,
    async (file) => {
      if (file === 'one') {
        await first.wait
        return '/out/one'
      }
      if (file === 'two') {
        await second.wait
        throw new Error('broken document')
      }
      await third.wait
      return '/out/three'
    },
    false,
  )
  const prompt = '  두 문서의 차이를 그대로 설명해 줘.\n'
  const delivered = gate()
  const followUp = gate()
  const deliver = vi.fn(async () => {
    delivered.release()
    return 'project answer'
  })
  const again = vi.fn(async () => {
    followUp.release()
    return 'follow-up answer'
  })
  const batchId = snap.id!
  queue.sendUnified({ dir, batchId, prompt, files: ['two', 'one'] }, owner, deliver)
  queue.sendUnified({ dir, batchId, prompt: '그 내용으로', files: ['one'] }, owner, again)
  first.release()
  await vi.waitFor(() => expect(queue.status(dir)!.items[1].state).toBe('running'))
  expect(deliver).not.toHaveBeenCalled()
  expect(again).not.toHaveBeenCalled()
  second.release()
  await delivered.wait
  await followUp.wait
  expect(deliver).toHaveBeenCalledTimes(1)
  expect(deliver).toHaveBeenCalledWith(
    [
      expect.objectContaining({ file: 'two', state: 'failed', error: 'broken document' }),
      expect.objectContaining({ file: 'one', state: 'saved', output: '/out/one' }),
    ],
    prompt,
    [],
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(Function),
  )
  expect(again).toHaveBeenCalledWith(
    [expect.objectContaining({ file: 'one' })],
    '그 내용으로',
    [{ prompt, reply: 'project answer' }],
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(Function),
  )
  third.release()
  await running
  const [a, b] = queue.status(dir)!.messages!
  expect(a).toMatchObject({
    reply: 'project answer',
    targets: [
      { file: 'two', state: 'done' },
      { file: 'one', state: 'done' },
    ],
  })
  expect(b.reply).toBe('follow-up answer')
})

it('invalidates the saved coverage only for a file actually edited by batch chat', async () => {
  const { queue, done } = harness()
  const saved = done()
  const run = queue.start(
    dir,
    ['one', 'two'],
    owner,
    async (file, _signal, report) => {
      report({ phase: 'translating', done: 2, total: 2, verified: true })
      return file + '.docx'
    },
    false,
  )
  await saved
  const settled = done()
  queue.sendUnified(
    { dir, batchId: run.id!, prompt: 'Read both and edit only file two', files: ['one', 'two'] },
    owner,
    async (_items, _prompt, _history, _signal, _text, onMutated) => {
      onMutated('other')
      onMutated('two')
      return 'Done'
    },
  )
  await settled
  const [read, changed] = queue.status(dir)!.items
  expect(read).toMatchObject({ verified: true, done: 2, total: 2 })
  expect(changed).toMatchObject({ state: 'saved', output: 'two.docx' })
  for (const key of ['verified', 'done', 'total']) expect(changed).not.toHaveProperty(key)
})
it('reruns saved and failed selections only for the specified batch, retaining other results and chat', async () => {
  const { queue, done } = harness()
  let finished = done()
  const old = queue.start(
    dir,
    ['one', 'two', 'three'],
    owner,
    async (file) => {
      if (file === 'two') throw Error('failed')
      return '/saved/' + file
    },
    false,
  )
  await finished
  finished = done()
  queue.sendUnified(
    { dir, batchId: old.id!, files: ['one'], prompt: 'status' },
    owner,
    async () => 'done',
  )
  await finished
  const previous = queue.status(dir)!
  const run = vi.fn(async (file) => '/new/' + file)
  expect(() => queue.start(dir, ['one'], owner, run, false, 'other')).toThrow()
  expect(() => queue.start(dir, ['outside'], owner, run, false, old.id)).toThrow()
  expect(() => queue.start(dir, [], owner, run, false, old.id)).toThrow()
  expect(() => queue.start(dir, ['one'], owner, run, true)).toThrow()
  expect(run).not.toHaveBeenCalled()
  finished = done()
  queue.start(dir, ['one', 'two'], owner, run, false, old.id)
  await finished
  const next = queue.status(dir)!
  expect(next.id).not.toBe(previous.id)
  expect(next.items.map((i) => i.output)).toEqual(['/new/one', '/new/two', '/saved/three'])
  expect(next.items[2]).toEqual(previous.items[2])
  expect(next.messages).toEqual(previous.messages)
  expect(run).toHaveBeenCalledTimes(2)
  expect(() => queue.start(dir, ['one'], owner, run, false, old.id)).toThrow()
})

it('tracks a failed project reply and stops every waiting or running target on cancellation', async () => {
  const { queue, done } = harness()
  let ready = done()
  const id = queue.start(dir, ['a', 'b'], owner, async (f) => f, false).id!
  await ready
  const args = { dir, batchId: id, files: ['a', 'b'], prompt: 'question' }
  ready = done()
  queue.sendUnified(args, owner, async () => {
    throw Error('provider unavailable')
  })
  await ready
  expect(queue.status(dir)!.messages![0].targets).toEqual(
    args.files.map((file) => ({ file, state: 'failed', error: 'provider unavailable' })),
  )
  ready = done()
  const started = gate()
  queue.sendUnified(args, owner, async (_items, _text, _context, signal) => {
    started.release()
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    )
    return 'late response'
  })
  await started.wait
  const never = vi.fn(async () => 'unexpected')
  queue.sendUnified(args, owner, never)
  queue.stopOwner(owner)
  await ready
  const messages = queue.status(dir)!.messages!.slice(1)
  expect(never).not.toHaveBeenCalled()
  for (const message of messages) {
    expect(message.reply).toBeUndefined()
    expect(message.targets.map((t) => t.state)).toEqual(['stopped', 'stopped'])
  }
})

it('keeps unresolved source excerpts available for review and retries only unfinished files', async () => {
  const { queue, done } = harness()
  const samples = Array.from({ length: 9 }, (_, i) => ({
    location: '197 · box ' + i,
    text: 'fragment ' + i,
  }))
  const first = done()
  queue.start(
    dir,
    ['one', 'two'],
    owner,
    async (file, _signal, report) => {
      if (file === 'one') {
        report({ done: 0, total: 9 })
        report({ savedOutput: 'partial.docx' })
        throw new BatchTranslationNeedsReview('Read the scan', samples)
      }
      return file
    },
    false,
  )
  await first
  expect(queue.status(dir)?.items[0]).toMatchObject({
    state: 'saved',
    output: 'partial.docx',
    done: 0,
    total: 9,
    reviewSamples: samples,
    error: 'Read the scan',
  })
  expect(() => queue.start(dir, ['one'], owner, vi.fn(), true)).toThrow('no unfinished')
})

it('keeps saved layout warnings separate from verified translation counts and clears them on rerun', async () => {
  const { queue, done } = harness()
  const first = done()
  const review = { count: 1, samples: [{ location: 'box 2', text: 'long label' }] }
  queue.start(
    dir,
    ['first.docx'],
    owner,
    async (_file, _signal, report) => {
      report({ phase: 'translating', done: 4, total: 4, verified: true })
      report({ phase: 'saving' })
      report({ savedOutput: 'first EN.docx' })
      report({ layoutReview: review })
    },
    false,
  )
  await first
  const snapshot = queue.status(dir)!
  expect(snapshot.items[0]).toMatchObject({
    state: 'saved',
    done: 4,
    total: 4,
    verified: true,
    layoutReview: review,
  })
  const second = done()
  queue.start(dir, ['first.docx'], owner, async () => 'first EN.docx', false, snapshot.id!)
  await second
  expect(queue.status(dir)?.items[0]?.layoutReview).toBeUndefined()
})
