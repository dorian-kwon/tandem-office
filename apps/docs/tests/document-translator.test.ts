import { describe, expect, it } from 'vitest'
import {
  AiDocumentTranslator,
  type DocumentTranslationRequest,
} from '../src/renderer/ai/document-translator'
import type { TranslationUnit, TranslationUnitIndex } from '../src/renderer/ai/translation-units'

const spec = { provider: 'test', model: 'pinned', targetLanguage: 'ko' }
function unit(id: string, text = id): TranslationUnit {
  return {
    id,
    version: 1,
    segments: [text],
    shape: 'plain',
    fp: 'collision',
    address: { kind: 'body', index: Number(id) || 0 },
  }
}
function fixture(units: TranslationUnit[]) {
  const current = new Map(units.map((u) => [u.id, u]))
  const applied: string[] = []
  const index: TranslationUnitIndex = {
    snapshot: () => [...current.values()],
    current: (id) => current.get(id),
    resolve: (u) => {
      const c = current.get(u.id)
      return c &&
        c.version === u.version &&
        c.shape === u.shape &&
        JSON.stringify(c.segments) === JSON.stringify(u.segments)
        ? c
        : null
    },
    dispose: () => {},
  }
  return {
    current,
    applied,
    index,
    commit: (u: TranslationUnit, segments: readonly string[]) => {
      const resolved = index.resolve(u)
      if (!resolved) return { status: 'stale' as const }
      const receipt = { ...resolved, version: resolved.version + 1, segments: [...segments] }
      current.set(u.id, receipt)
      applied.push(u.id)
      return { status: 'applied' as const, receipt }
    },
  }
}
function answer(request: DocumentTranslationRequest) {
  return JSON.stringify({
    translations: request.units.map((u) => ({
      id: u.id,
      segments: u.segments.map((s) => `translated:${s}`),
    })),
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('document translator', () => {
  it('bounds active requests and applies reverse completions in source order', async () => {
    const f = fixture(Array.from({ length: 25 }, (_, i) => unit(String(i))))
    const requests: {
      request: DocumentTranslationRequest
      result: ReturnType<typeof deferred<string>>
    }[] = []
    const runner = new AiDocumentTranslator({
      ...f,
      request: (request) => {
        const result = deferred<string>()
        requests.push({ request, result })
        return result.promise
      },
    })
    const run = runner.run(spec)
    expect(requests).toHaveLength(2)
    requests[1].result.resolve(answer(requests[1].request))
    await tick()
    expect(f.applied).toEqual([])
    expect(requests.length).toBeLessThanOrEqual(3)
    requests[0].result.resolve(answer(requests[0].request))
    await tick()
    if (requests[2]) requests[2].result.resolve(answer(requests[2].request))
    expect((await run).completed).toBe(25)
    expect(f.applied).toEqual(Array.from({ length: 25 }, (_, i) => String(i)))
    expect(requests.map((r) => r.request.units.length)).toEqual([12, 12, 1])
  })

  it('keeps long paragraphs whole, packs serialized lengths, and reports oversized units', async () => {
    const f = fixture([
      unit('a', 'a'.repeat(4000)),
      unit('b', 'b'.repeat(4000)),
      unit('c', 'c'.repeat(7000)),
      unit('d', 'd'.repeat(24001)),
    ])
    const sent: string[][] = []
    const runner = new AiDocumentTranslator({
      ...f,
      request: async (r) => {
        sent.push(r.units.map((u) => u.id))
        return answer(r)
      },
    })
    expect(await runner.run(spec)).toMatchObject({ completed: 3, skipped: 1 })
    expect(sent).toEqual([['a'], ['b'], ['c']])
  })

  it.each([
    { translations: [{ id: 'a', segments: ['ok'] }] },
    {
      translations: [
        { id: 'a', segments: ['ok'] },
        { id: 'a', segments: ['ok'] },
      ],
    },
    {
      translations: [
        { id: 'a', segments: ['ok'] },
        { id: 'b', segments: [] },
      ],
    },
    {
      translations: [
        { id: 'a', segments: ['ok'] },
        { id: 'b', segments: ['ok'], extra: true },
      ],
    },
  ])('refuses incomplete or malformed whole batch replies %j', async (response) => {
    const f = fixture([unit('a'), unit('b')])
    const runner = new AiDocumentTranslator({ ...f, request: async () => JSON.stringify(response) })
    expect(await runner.run(spec)).toMatchObject({ completed: 0, failed: 2 })
    expect(f.applied).toEqual([])
  })

  it('excludes edits despite matching fingerprints and resolves moved addresses at commit', async () => {
    const f = fixture([unit('a'), unit('b')])
    const wait = deferred<string>()
    let request!: DocumentTranslationRequest
    const runner = new AiDocumentTranslator({
      ...f,
      request: (r) => {
        request = r
        return wait.promise
      },
    })
    const run = runner.run(spec)
    f.current.set('a', { ...unit('a', 'edited'), version: 2 })
    f.current.set('b', { ...unit('b'), address: { kind: 'body', index: 9 } })
    wait.resolve(answer(request))
    expect(await run).toMatchObject({ completed: 1, stale: 1 })
    expect(f.current.get('b')?.address).toEqual({ kind: 'body', index: 9 })
  })

  it('reuses completed buffers after stop, ignores late output, and skips unchanged receipts', async () => {
    const f = fixture(Array.from({ length: 24 }, (_, i) => unit(String(i))))
    const requests: {
      request: DocumentTranslationRequest
      result: ReturnType<typeof deferred<string>>
    }[] = []
    let automatic = false
    const runner = new AiDocumentTranslator({
      ...f,
      request: (request) => {
        if (automatic) return Promise.resolve(answer(request))
        const result = deferred<string>()
        requests.push({ request, result })
        return result.promise
      },
    })
    const first = runner.run(spec)
    requests[1].result.resolve(answer(requests[1].request))
    await tick()
    runner.stop()
    expect(await first).toMatchObject({ stopped: true, completed: 0 })
    expect(requests.every((r) => r.request.signal.aborted)).toBe(true)
    requests[0].result.resolve(answer(requests[0].request))
    await tick()
    automatic = true
    expect(await runner.run(spec)).toMatchObject({ completed: 24, reused: 12 })
    expect(await runner.run(spec)).toMatchObject({ completed: 0, reused: 24 })
    expect(f.applied).toHaveLength(24)
  })

  it('invalidates receipts after edits or undo and isolates every translation context', async () => {
    const f = fixture([unit('a'), unit('b')])
    let sent = 0
    const runner = new AiDocumentTranslator({
      ...f,
      request: async (r) => {
        sent += r.units.length
        return answer(r)
      },
    })
    await runner.run(spec)
    f.current.set('a', { ...unit('a', 'user edit'), version: 3 })
    expect(await runner.run(spec)).toMatchObject({ completed: 1, reused: 1 })
    expect(sent).toBe(3)
    f.current.set('b', { ...unit('b'), version: 3 })
    expect(await runner.run(spec)).toMatchObject({ completed: 1, reused: 1 })
    for (const change of [
      { provider: 'other' },
      { model: 'other' },
      { context: 'terms' },
      { glossary: 'terms' },
      { style: 'formal' },
      { instructions: 'short' },
      { sourceLanguage: 'en' },
      { targetLanguage: 'fr' },
    ]) {
      expect(await runner.run({ ...spec, ...change })).toMatchObject({ completed: 2, reused: 0 })
    }
  })

  it('captures rollback before first write and reports partial progress on parent cancellation', async () => {
    const f = fixture([unit('a'), unit('b')])
    const parent = new AbortController()
    const events: string[] = []
    const runner = new AiDocumentTranslator({
      ...f,
      request: async (r) => answer(r),
      onBeforeCommit: () => events.push('snapshot'),
      commit: (u, s) => {
        events.push(u.id)
        const result = f.commit(u, s)
        parent.abort()
        return result
      },
      onProgress: (r) => events.push(`progress:${r.completed}`),
    })
    expect(await runner.run(spec, parent.signal)).toMatchObject({
      completed: 1,
      stopped: true,
      pending: 1,
    })
    expect(events.indexOf('snapshot')).toBeLessThan(events.indexOf('a'))
    expect(events).toContain('progress:1')
    expect(f.applied).toEqual(['a'])
  })
  it('aborts other requests if rollback snapshot capture fails', async () => {
    const f = fixture(Array.from({ length: 24 }, (_, i) => unit(String(i))))
    const requests: DocumentTranslationRequest[] = []
    const replies = [deferred<string>(), deferred<string>()]
    const runner = new AiDocumentTranslator({
      ...f,
      request: (r) => {
        requests.push(r)
        return replies[requests.length - 1].promise
      },
      onBeforeCommit: () => {
        throw new Error('Snapshot unavailable')
      },
    })
    const run = runner.run(spec)
    replies[0].resolve(answer(requests[0]))
    await expect(run).rejects.toThrow('Snapshot unavailable')
    expect(requests.every((r) => r.signal.aborted)).toBe(true)
    replies[1].resolve(answer(requests[1]))
    await tick()
    expect(f.applied).toEqual([])
  })

  it('preserves the selected subscription default model when its ID is empty', async () => {
    const f = fixture([unit('a')])
    const models: string[] = []
    const runner = new AiDocumentTranslator({
      ...f,
      request: async (r) => {
        models.push(r.spec.model)
        return answer(r)
      },
    })
    expect(await runner.run({ ...spec, model: '' })).toMatchObject({ completed: 1 })
    expect(models).toEqual([''])
  })
  it('suppresses obsolete run progress while a replacement run is pending', async () => {
    const f = fixture([unit('a')])
    const requests: DocumentTranslationRequest[] = []
    const replies = [deferred<string>(), deferred<string>()]
    const progress: { stopped: boolean; completed: number }[] = []
    const runner = new AiDocumentTranslator({
      ...f,
      request: (r) => {
        requests.push(r)
        return replies[requests.length - 1].promise
      },
      onProgress: (r) => progress.push({ stopped: r.stopped, completed: r.completed }),
    })
    const first = runner.run(spec)
    const second = runner.run({ ...spec, targetLanguage: 'fr' })
    expect(await first).toMatchObject({ stopped: true })
    expect(progress).toEqual([])
    replies[1].resolve(answer(requests[1]))
    expect(await second).toMatchObject({ completed: 1, stopped: false })
    expect(progress.every((r) => !r.stopped && r.completed === 1)).toBe(true)
    replies[0].resolve(answer(requests[0]))
    await tick()
    expect(f.applied).toEqual(['a'])
  })
  it('retains a hundred small applied receipts with a large shared project context', async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => unit(String(i))))
    let requests = 0
    const runner = new AiDocumentTranslator({
      ...f,
      request: async (r) => {
        requests++
        return answer(r)
      },
    })
    const contextual = { ...spec, context: 'project guidance '.repeat(1250) }
    expect(await runner.run(contextual)).toMatchObject({ completed: 100 })
    const firstRequests = requests
    expect(await runner.run(contextual)).toMatchObject({ completed: 0, reused: 100 })
    expect(requests).toBe(firstRequests)
    expect(f.applied).toHaveLength(100)
  })
})
