import { describe, expect, it, vi } from 'vitest'
import type { SourceEntry } from '@genoffice/translate-project'
import {
  OcrFailedError,
  runOcr,
  safeOcrMessage,
  type OcrAsk,
  type OcrBridge,
  type OcrPrepared,
  type OcrSettled,
} from '../src/shared/translate-ocr'

/**
 * What a run reports about every picture, before anything is handed on: read, failed with a
 * reason, or stopped. A failure is never silent and never carries a path or a secret.
 */

const SOURCE: SourceEntry = { file: 'book.xlsx', sha256: 'x', kind: 'editable' } as SourceEntry
const OK = '<page-content>\nHello\n</page-content>'

function setup(count = 3) {
  const prepared: OcrPrepared = {
    token: 'tok',
    kind: 'embedded',
    ocr: { kind: 'ai', provider: 'claude' },
    items: Array.from({ length: count }, (_, i) => ({ index: i + 1, name: `image${i + 1}.jpg` })),
  }
  const bridge = {
    prepare: vi.fn(async () => prepared),
    start: vi.fn(async () => undefined),
    pageImage: vi.fn(async (_t: string, index: number) => ({
      data: new Uint8Array([index]),
      mime: 'image/jpeg' as const,
    })),
    write: vi.fn(async () => ({ outputPath: '/x' })),
    release: vi.fn(async () => undefined),
  } satisfies OcrBridge
  return { prepared, bridge }
}

const run = (ask: OcrAsk, onSettled: (o: OcrSettled) => void, count = 3) => {
  const { prepared, bridge } = setup(count)
  return runOcr({
    dir: '/p',
    source: SOURCE,
    selection: { kind: 'all' },
    prepared,
    confirm: async () => true,
    bridge,
    ask,
    onSettled,
    choosePlacement: async () => null,
  }).catch((err: unknown) => err)
}

describe('runOcr onSettled', () => {
  it('reports a failed picture with its reason while the others are kept', async () => {
    const settled = vi.fn()
    const ask: OcrAsk = async (_p, request) =>
      request.messages[0]!.images![0]!.base64 === 'Ag==' ? 'no tags here' : OK
    await run(ask, settled)
    expect(settled).toHaveBeenCalledTimes(1)
    const out = settled.mock.calls[0]![0] as OcrSettled
    expect(out.read).toEqual([1, 3])
    expect(out.failures).toEqual([{ index: 2, reason: 'malformed', message: expect.any(String) }])
  })

  it('reports a call error as a failure with the provider text, without a path', async () => {
    const settled = vi.fn()
    const ask: OcrAsk = async (_p, request) => {
      if (request.messages[0]!.images![0]!.base64 === 'AQ==')
        throw new Error('spawn failed at /home/user/.local/bin/claude: boom')
      return OK
    }
    await run(ask, settled)
    const out = settled.mock.calls[0]![0] as OcrSettled
    expect(out.read).toEqual([2, 3])
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toMatchObject({ index: 1, reason: 'error' })
    expect(out.failures[0]!.message).not.toContain('/Users/')
    expect(out.failures[0]!.message).toContain('boom')
  })

  it('still reports when every picture failed, and then the run ends with an error', async () => {
    const settled = vi.fn()
    const err = await run(async () => 'nothing usable', settled, 2)
    expect(err).toBeInstanceOf(OcrFailedError)
    const out = settled.mock.calls[0]![0] as OcrSettled
    expect(out.read).toEqual([])
    expect(out.failures.map((f) => f.index)).toEqual([1, 2])
  })
})

describe('safeOcrMessage', () => {
  it('drops absolute paths and long token-like strings and bounds the length', () => {
    const text = safeOcrMessage(
      new Error(
        `failed C:\\Users\\me\\x.exe and /home/me/.codex/auth.json sk-${'a'.repeat(40)} ${'z'.repeat(400)}`,
      ),
    )
    expect(text).not.toMatch(/Users|\/home|auth\.json|sk-a/)
    expect(text.length).toBeLessThanOrEqual(200)
  })
})
