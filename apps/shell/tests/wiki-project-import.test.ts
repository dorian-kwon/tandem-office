import { createHash } from 'node:crypto'
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFileToText } from '@genoffice/file-parse'
import { ingestFinalNote } from '../src/main/translate/wiki-final-notes'
import { learnFinalPath } from '../src/main/translate/wiki-import-worker'

vi.mock('@genoffice/file-parse', () => ({
  parseFileToText: vi.fn(),
  stopParseSidecar: vi.fn(),
}))

describe('project wiki input', () => {
  let root: string
  let projectDir: string
  let profileDir: string
  let source: string
  const opts = () => ({ lang: 'en' as const, profileDir, projectDir, cliEntry: '' })

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'wiki-project-input-')))
    projectDir = join(root, 'project')
    profileDir = join(root, 'profile')
    source = join(projectDir, 'output', 'guide.txt')
    await mkdir(dirname(source), { recursive: true })
    await writeFile(source, 'Finished text.')
    vi.mocked(parseFileToText).mockReset()
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('skips original copies before parsing', async () => {
    const original = createHash('sha256').update('Finished text.').digest('hex')
    expect(
      await learnFinalPath(source, { ...opts(), sourceHashes: { 'guide.txt': original } }),
    ).toBe('unchanged-source')
    expect(parseFileToText).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['project'])
  })

  it('parses the checked private snapshot and removes it even if the input is swapped', async () => {
    let parsed = ''
    vi.mocked(parseFileToText).mockImplementation(async (input) => {
      parsed = input
      expect(dirname(input)).not.toBe(dirname(source))
      await rename(source, source + '.old')
      await writeFile(source, 'Replacement')
      return { ok: true, kind: 'text', text: await readFile(input, 'utf8') }
    })
    expect(await learnFinalPath(source, opts())).toBe('added')
    await expect(readFile(parsed)).rejects.toMatchObject({ code: 'ENOENT' })
    const folder = join(profileDir, 'translation-wiki', 'vault', 'final-documents')
    const [name] = await readdir(folder)
    expect(await readFile(join(folder, name!), 'utf8')).toContain('    Finished text.')
  })

  it('updates home imports by source path and preserves links, personal notes and other files with the same name', async () => {
    const home = { lang: 'en' as const, profileDir, cliEntry: '' }
    vi.mocked(parseFileToText).mockImplementation(async (input) => ({
      ok: true,
      kind: 'text',
      text: await readFile(input, 'utf8'),
    }))
    expect(await learnFinalPath(source, home)).toBe('added')
    const folder = join(profileDir, 'translation-wiki', 'vault', 'final-documents')
    const [note] = await readdir(folder)
    const path = join(folder, note!)
    const personal = (await readFile(path, 'utf8')) + '[[My glossary]]\nMy own note.\n'
    await writeFile(path, personal)
    expect(await learnFinalPath(source, home)).toBe('duplicate')
    expect(await readFile(path, 'utf8')).toBe(personal)
    const other = join(root, 'guide.txt')
    await writeFile(other, 'Finished text.')
    expect(await learnFinalPath(other, home)).toBe('added')
    await writeFile(source, 'Revised text.')
    expect(await learnFinalPath(source, home)).toBe('updated')
    const current = await readFile(path, 'utf8')
    expect(current).toContain('    Revised text.')
    expect(current).not.toContain('    Finished text.')
    expect(current).not.toContain(projectDir)
    expect(current).toContain('[[My glossary]]\nMy own note.')
    expect(await readdir(folder)).toHaveLength(2)
  })

  it('binds a matching v0.15.12 note without breaking links or sharing it with another source', async () => {
    const home = { lang: 'ko' as const, profileDir, cliEntry: '' }
    vi.mocked(parseFileToText).mockImplementation(async (input) => ({
      ok: true,
      kind: 'text',
      text: await readFile(input, 'utf8'),
    }))
    const revision = createHash('sha256').update('Finished text.').digest('hex')
    await ingestFinalNote(profileDir, 'en', 'guide.txt', 'Finished text.', revision)
    const folder = join(profileDir, 'translation-wiki', 'vault', 'final-documents')
    const [legacy] = await readdir(folder)
    const path = join(folder, legacy!)
    // Previous releases generated no classification or ownership marker.
    const old = (await readFile(path, 'utf8')).replace(
      /^<!-- tandem:wiki-classification .* -->\n/m,
      '',
    )
    const edited =
      old.replace('    Finished text.', '    My corrected example.') + '[[Personal note]]\n'
    await writeFile(path, edited.replaceAll('\n', '\r\n'))
    expect(await learnFinalPath(source, home)).toBe('duplicate')
    expect(await readFile(path, 'utf8')).toContain('    My corrected example.\r\n')
    const other = join(root, 'guide.txt')
    await writeFile(other, 'Finished text.')
    expect(await learnFinalPath(other, home)).toBe('added')
    await writeFile(source, 'New edition.')
    expect(await learnFinalPath(source, home)).toBe('updated')
    const current = await readFile(path, 'utf8')
    expect(current).toContain('    New edition.\r\n')
    expect(current).toContain('[[Personal note]]\r\n')
    expect(current).not.toContain('My corrected example.')
    expect(await readdir(folder)).toHaveLength(2)
  })

  it('preserves a fully rewritten legacy note on an exact repeat import', async () => {
    const home = { lang: 'en' as const, profileDir, cliEntry: '' }
    vi.mocked(parseFileToText).mockResolvedValue({ ok: true, kind: 'text', text: 'Finished text.' })
    const revision = createHash('sha256').update('Finished text.').digest('hex')
    await ingestFinalNote(profileDir, 'en', 'guide.txt', 'Finished text.', revision)
    const folder = join(profileDir, 'translation-wiki', 'vault', 'final-documents')
    const [name] = await readdir(folder)
    await writeFile(join(folder, name!), 'A personal note.')
    expect(await learnFinalPath(source, home)).toBe('duplicate')
    expect(await readdir(folder)).toEqual([name])
    expect(await readFile(join(folder, name!), 'utf8')).toBe('A personal note.')
  })

  it('rejects a linked output folder, linked files and paths outside output', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    const other = join(outside, 'guide.txt')
    await writeFile(other, 'Other document')
    await expect(learnFinalPath(other, opts())).rejects.toThrow()
    await unlink(source)
    await link(other, source)
    await expect(learnFinalPath(source, opts())).rejects.toThrow()
    await unlink(source)
    if (process.platform !== 'win32') {
      await symlink(other, source)
      await expect(learnFinalPath(source, opts())).rejects.toThrow()
      await unlink(source)
    }
    await rm(dirname(source), { recursive: true })
    await symlink(outside, dirname(source), 'junction')
    await expect(learnFinalPath(source, opts())).rejects.toThrow()
    expect(parseFileToText).not.toHaveBeenCalled()
  })
})
