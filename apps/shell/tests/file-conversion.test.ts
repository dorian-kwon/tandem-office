import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileConversionSession } from '../src/main/file-conversion'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'file-convert-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
const active = () => true

describe('file conversion from Home', () => {
  it('limits output formats and input paths to the user selection', async () => {
    const session = new FileConversionSession()
    const picked = session.pick(['/a/PLAN.DOCX', '/b/PLAN.DOCX', '/a/PLAN.DOCX'])
    expect(picked).toHaveLength(2)
    expect(picked[0]!.id).not.toEqual(picked[1]!.id)
    expect(picked[0]!.targets).toContain('pdf')
    expect(session.pick(['/a/PLAN.DOCX'])[0]!.id).toBe(picked[0]!.id)
    expect(session.pick(['/a/book.tsv'])[0]!.targets).toEqual(
      expect.arrayContaining(['xlsx', 'pdf', 'hwp', 'docx']),
    )
    expect(session.pick(['/a/book.constructor'])[0]!.targets).toEqual([])
    const convert = vi.fn()
    for (const [ids, target] of [
      [['/a/PLAN.DOCX'], 'pdf'],
      [[picked[0]!.id], '../../bad'],
    ]) {
      await expect(session.run(ids, target, convert, vi.fn(), active)).rejects.toThrow()
    }
    expect(convert).not.toHaveBeenCalled()
  })

  it('converts in order beside each original, preserving occupied files and cleaning failed outputs', async () => {
    const a = join(dir, 'trip.MD'),
      broken = join(dir, 'broken.md'),
      other = join(dir, 'other'),
      b = join(other, 'trip.md')
    await mkdir(other)
    await writeFile(a, 'A')
    await writeFile(b, 'B')
    await writeFile(broken, 'Broken')
    await writeFile(join(dir, 'trip.html'), 'occupied')
    const session = new FileConversionSession()
    const picked = session.pick([a, broken, b])
    const progress = vi.fn()
    const calls: string[] = []
    const results = await session.run(
      picked.map((x) => x.id),
      'html',
      async (source, _format, out) => {
        calls.push(source)
        await writeFile(out, await readFile(source))
        if (source === broken) throw new Error('Cannot parse document')
      },
      progress,
      active,
    )
    expect(calls).toEqual([a, broken, b])
    expect(progress.mock.calls.map(([r]) => r)).toEqual(results)
    expect(results[0]!.outputPath).toBe(join(dir, 'trip (2).html'))
    expect(results[1]!.error).toBe('Cannot parse document')
    expect(results[2]!.outputPath).toBe(join(other, 'trip.html'))
    expect(await readFile(a, 'utf8')).toBe('A')
    expect(await readFile(join(dir, 'trip.html'), 'utf8')).toBe('occupied')
    expect(await readFile(results[2]!.outputPath!, 'utf8')).toBe('B')
    expect(await readdir(dir)).not.toContain('broken.html')
    expect((await readdir(dir)).filter((x) => x.startsWith('.convert-'))).toEqual([])
  })

  it('keeps PDF picture ownership under the final Markdown file name', async () => {
    const session = new FileConversionSession()
    const [source] = session.pick([join(dir, 'plan.pdf')])
    await writeFile(join(dir, 'plan.md'), 'occupied')
    const image = 'test.png',
      hash = 'a'.repeat(64)
    const manifestPath = join(dir, 'assets', '.genoffice-assets.json')
    const results = await session.run(
      [source!.id],
      'md',
      async (_source, _target, out) => {
        await mkdir(join(dirname(out), 'assets'))
        await writeFile(
          manifestPath,
          JSON.stringify({
            version: 1,
            files: [{ name: image, sha256: hash }],
            documents: { [basename(out)]: [image] },
            pending: {},
          }),
        )
        await writeFile(out, `![figure](assets/${image})`)
      },
      vi.fn(),
      active,
    )
    expect(results[0]!.outputPath).toBe(join(dir, 'plan (2).md'))
    expect(JSON.parse(await readFile(manifestPath, 'utf8')).documents).toEqual({
      'plan (2).md': [image],
    })
  })

  it('reports the saved Markdown file even if its picture metadata changed during publication', async () => {
    const session = new FileConversionSession()
    const [source] = session.pick([join(dir, 'report.pdf')])
    const results = await session.run(
      [source!.id],
      'md',
      async (_input, _format, out) => {
        await writeFile(out, 'Report')
        await mkdir(join(dir, 'assets'))
        await writeFile(join(dir, 'assets', '.genoffice-assets.json'), '{')
      },
      vi.fn(),
      active,
    )
    expect(results).toEqual([
      {
        id: source!.id,
        outputPath: join(dir, 'report.md'),
        warning: expect.stringContaining('manifest'),
      },
    ])
    expect(await readFile(join(dir, 'report.md'), 'utf8')).toBe('Report')
    expect(await readdir(dir)).not.toContain('report (2).md')
  })

  it('does not run a second batch concurrently in the window', async () => {
    const session = new FileConversionSession()
    const ids = session.pick([join(dir, 'a.md')]).map((x) => x.id)
    let finish!: () => void
    const barrier = new Promise<void>((r) => {
      finish = r
    })
    const first = session.run(
      ids,
      'html',
      async (_input, _format, out) => {
        await barrier
        await writeFile(out, 'finished')
      },
      vi.fn(),
      active,
    )
    await expect(session.run(ids, 'html', vi.fn(), vi.fn(), active)).rejects.toThrow(
      'already running',
    )
    finish()
    expect((await first)[0]!.outputPath).toBe(join(dir, 'a.html'))
  })
})
