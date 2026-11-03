import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryReferences, syncReferenceIndex, type ReferenceConverter } from './reference-index'
import { createProject } from './project-store'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})

let root: string
let dir: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'refcache-'))
  dir = (await createProject(root, 'proj', 'ko', 'en')).dir
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const asText: ReferenceConverter = async (path) => ({
  ok: true,
  md: (await fsp.readFile(path, 'utf8')) as string,
})

describe('the per-request cache', () => {
  it('reads neither the index nor an unchanged converted copy again', async () => {
    await writeFile(join(dir, 'references', 'a.md'), '# One\n\nfirst words', 'utf8')
    await syncReferenceIndex(dir, ['a.md'], asText)
    const reads = vi.mocked(fsp.readFile)
    reads.mockClear()
    await queryReferences(dir, 'first', 1000)
    // the first request reads the index and the copy
    expect(reads).toHaveBeenCalledTimes(2)
    reads.mockClear()
    const hits = await queryReferences(dir, 'first', 1000)
    expect(hits).toHaveLength(1)
    expect(reads).not.toHaveBeenCalled()
  })

  it('reads a converted copy again once it changed', async () => {
    await writeFile(join(dir, 'references', 'a.md'), '# One\n\nfirst words', 'utf8')
    await syncReferenceIndex(dir, ['a.md'], asText)
    await queryReferences(dir, 'first', 1000)
    await writeFile(join(dir, 'references', '.md', 'a.md.md'), 'edited by hand, longer', 'utf8')
    // the edited copy no longer matches the index: skipped, not sent
    expect(await queryReferences(dir, 'first', 1000)).toEqual([])
  })
})
