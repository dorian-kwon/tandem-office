import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as projectFile from './project-file'
import {
  InvalidProjectNameError,
  NotAProjectError,
  ProjectExistsError,
  createProject,
  loadProject,
  makeFolder,
  projectStatus,
  removeProject,
  saveProject,
} from './project-store'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

vi.mock('./project-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-file')>()
  return { ...actual, serializeProjectFile: vi.fn(actual.serializeProjectFile) }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'project-store-'))
})

afterEach(async () => {
  vi.mocked(projectFile.serializeProjectFile).mockReset()
  vi.mocked(rm).mockReset()
  await rm(root, { recursive: true, force: true })
})

const isDir = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => null))?.isDirectory() === true

describe('makeFolder', () => {
  it('makes a plain folder inside the parent and never reuses an existing one', async () => {
    const dir = await makeFolder(root, 'My Place')
    expect(dir).toBe(join(root, 'My Place'))
    expect(await isDir(dir)).toBe(true)
    await expect(makeFolder(root, 'My Place')).rejects.toBeInstanceOf(ProjectExistsError)
  })

  it('applies the project folder name rules', async () => {
    await expect(makeFolder(root, '  ')).rejects.toBeInstanceOf(InvalidProjectNameError)
    await expect(makeFolder(root, '..')).rejects.toBeInstanceOf(InvalidProjectNameError)
    await expect(makeFolder(root, 'con')).rejects.toBeInstanceOf(InvalidProjectNameError)
    // characters invalid on Windows are stripped, so the name stays a single folder
    expect(await makeFolder(root, 'a/b')).toBe(join(root, 'ab'))
  })
})

describe('createProject', () => {
  it('starts with Claude for OCR, or with the provider it is given', async () => {
    expect((await createProject(root, 'A', 'ko', 'en')).project.ocr).toEqual({
      kind: 'ai',
      provider: 'claude',
    })
    const b = await createProject(root, 'B', 'ko', 'en', { kind: 'ai', provider: 'chatgpt' })
    expect(b.project.ocr).toEqual({ kind: 'ai', provider: 'chatgpt' })
    expect((await loadProject(b.dir)).ocr).toEqual({ kind: 'ai', provider: 'chatgpt' })
  })

  it('creates the full folder layout', async () => {
    const { dir, project } = await createProject(root, 'My Book', 'ko', 'en')
    expect(dir).toBe(join(root, 'My Book'))
    for (const sub of ['source', 'references', 'glossary', 'output', '.tandem']) {
      expect(await isDir(join(dir, sub))).toBe(true)
    }
    expect(await isDir(join(dir, '.ieumoffice'))).toBe(false)
    expect(project.name).toBe('My Book')
    expect(await loadProject(dir)).toEqual(project)
  })

  it('refuses to overwrite an existing folder', async () => {
    await mkdir(join(root, 'Taken'))
    await expect(createProject(root, 'Taken', 'ko', 'en')).rejects.toBeInstanceOf(
      ProjectExistsError,
    )
  })

  it('makes the folder name filesystem-safe but keeps the typed name', async () => {
    const { dir, project } = await createProject(root, 'a/b:c? ', 'ko', 'en')
    expect(dir).toBe(join(root, 'abc'))
    expect(project.name).toBe('a/b:c? ')
  })

  it('rejects names that are empty after sanitizing', async () => {
    await expect(createProject(root, ' /:*. ', 'ko', 'en')).rejects.toBeInstanceOf(
      InvalidProjectNameError,
    )
    await expect(createProject(root, '', 'ko', 'en')).rejects.toBeInstanceOf(
      InvalidProjectNameError,
    )
  })
})

describe('createProject names and failures', () => {
  it.each(['CON', 'nul', 'com1.txt'])('rejects Windows reserved name %s', async (name) => {
    await expect(createProject(root, name, 'ko', 'en')).rejects.toBeInstanceOf(
      InvalidProjectNameError,
    )
  })

  it.each(['console', 'Project NUL'])('accepts %s', async (name) => {
    const { dir } = await createProject(root, name, 'ko', 'en')
    expect(await projectStatus(dir)).toBe('ok')
  })

  it('reports the original error when cleanup itself fails', async () => {
    vi.mocked(projectFile.serializeProjectFile).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    vi.mocked(rm).mockRejectedValue(new Error('EPERM cleanup'))
    // Every rm fails, including the temp-file cleanup inside saveProject.
    await expect(createProject(root, 'Stuck', 'ko', 'en')).rejects.toThrow('boom')
  })

  it('removes the partial folder after a failed create so a retry succeeds', async () => {
    vi.mocked(projectFile.serializeProjectFile).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    await expect(createProject(root, 'Retry', 'ko', 'en')).rejects.toThrow('boom')
    expect(await isDir(join(root, 'Retry'))).toBe(false)
    const { dir } = await createProject(root, 'Retry', 'ko', 'en')
    expect(await projectStatus(dir)).toBe('ok')
  })
})

describe('saveProject / loadProject', () => {
  it('loads what was saved', async () => {
    const { dir, project } = await createProject(root, 'P', 'ko', 'en')
    const next = { ...project, projectPrompt: 'formal tone', references: ['a.txt'] }
    await saveProject(dir, next)
    expect(await loadProject(dir)).toEqual(next)
  })

  it('leaves no temp file behind after success', async () => {
    const { dir, project } = await createProject(root, 'P', 'ko', 'en')
    await saveProject(dir, project)
    expect(await readdir(join(dir, '.tandem'))).toEqual(['project.json'])
  })

  it('leaves no temp file behind when the rename fails', async () => {
    const { dir, project } = await createProject(root, 'P', 'ko', 'en')
    await rm(join(dir, '.tandem', 'project.json'))
    await mkdir(join(dir, '.tandem', 'project.json', 'blocker'), { recursive: true })
    await expect(saveProject(dir, project)).rejects.toThrow()
    expect(await readdir(join(dir, '.tandem'))).toEqual(['project.json'])
  })
})

describe('projectStatus', () => {
  it('is ok for a valid project', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    expect(await projectStatus(dir)).toBe('ok')
  })

  it('is not-found for a moved folder', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    expect(await projectStatus(join(root, 'moved'))).toBe('not-found')
    await rm(join(dir, '.tandem', 'project.json'))
    expect(await projectStatus(dir)).toBe('not-found')
  })

  it('is invalid for a corrupt project.json', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    await writeFile(join(dir, '.tandem', 'project.json'), '{ nope')
    expect(await projectStatus(dir)).toBe('invalid')
  })
})

describe('removeProject', () => {
  it('with deleteFolder false leaves files', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    await removeProject(dir, { deleteFolder: false })
    expect(await projectStatus(dir)).toBe('ok')
  })

  it('with deleteFolder true removes the directory', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    await writeFile(join(dir, 'source', 'x.txt'), 'x')
    await removeProject(dir, { deleteFolder: true })
    expect(await isDir(dir)).toBe(false)
  })

  it('refuses to delete a folder that is not a project', async () => {
    const other = join(root, 'other')
    await mkdir(other)
    await writeFile(join(other, 'keep.txt'), 'keep')
    await expect(removeProject(other, { deleteFolder: true })).rejects.toBeInstanceOf(
      NotAProjectError,
    )
    expect(await readFile(join(other, 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('refuses to delete when project.json is corrupt', async () => {
    const { dir } = await createProject(root, 'P', 'ko', 'en')
    await writeFile(join(dir, '.tandem', 'project.json'), 'garbage')
    await expect(removeProject(dir, { deleteFolder: true })).rejects.toBeInstanceOf(
      NotAProjectError,
    )
    expect(await isDir(dir)).toBe(true)
  })
})
