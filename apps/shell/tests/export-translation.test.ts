import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, importSource, type SourceEntry } from '@genoffice/translate-project'
import {
  exportTranslation,
  type ExportTranslationDeps,
} from '../src/main/translate/export-translation'
import { parseTranslateError } from '../src/shared/translate-api'

/**
 * Exporting the translated document: the current saved output file is copied, byte for
 * byte, to the path the save dialog returned. Real project folders, a fake save dialog.
 */

let root: string
let dir: string
let picked: string | null
let dirty: boolean
let dialog: ReturnType<typeof vi.fn>
let deps: ExportTranslationDeps

const BYTES = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 128, 7, 9, 200])

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'export-translation-'))
  dir = (await createProject(root, 'P', 'en', 'ko')).dir
  picked = null
  dirty = false
  dialog = vi.fn(async () => (picked === null ? { canceled: true } : { canceled: false, filePath: picked }))
  deps = {
    showSaveDialog: dialog as unknown as ExportTranslationDeps['showSaveDialog'],
    isDirty: async () => dirty,
    documentsDir: () => join(root, 'Documents'),
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function addSource(name: string, bytes: Buffer | string = 'source'): Promise<SourceEntry> {
  const original = join(root, name)
  writeFileSync(original, bytes)
  return importSource(dir, original)
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    return parseTranslateError(err).code
  }
  return 'resolved'
}

describe('exportTranslation', () => {
  it('copies the saved output to the chosen path with identical bytes, same extension', async () => {
    const entry = await addSource('report.docx')
    writeFileSync(join(dir, 'output', 'report.docx'), BYTES)
    mkdirSync(join(root, 'out'))
    picked = join(root, 'out', 'report (ko).docx')
    const result = await exportTranslation(dir, entry, undefined, 'ko', deps)
    expect(result).toEqual({ status: 'saved', path: picked })
    expect(readFileSync(picked).equals(BYTES)).toBe(true)
    // the output and the source copy are untouched
    expect(readFileSync(join(dir, 'output', 'report.docx')).equals(BYTES)).toBe(true)
    expect(readFileSync(join(dir, 'source', 'report.docx'), 'utf8')).toBe('source')
  })

  it('offers "<original name> (<target language>)" with the original extension, in the project folder', async () => {
    const entry = await addSource('budget.xlsx')
    writeFileSync(join(dir, 'output', 'budget.xlsx'), BYTES)
    await exportTranslation(dir, entry, undefined, 'ja', deps)
    const options = dialog.mock.calls[0]![0] as { defaultPath: string }
    expect(options.defaultPath).toBe(join(dir, 'budget (ja).xlsx'))
  })

  it('does nothing when the dialog is cancelled', async () => {
    const entry = await addSource('a.md')
    writeFileSync(join(dir, 'output', 'a.md'), 'translated')
    picked = null
    const result = await exportTranslation(dir, entry, undefined, 'ko', deps)
    expect(result).toEqual({ status: 'canceled' })
  })

  it('reports a clear error when there is no output yet and never opens the dialog', async () => {
    const entry = await addSource('a.md')
    expect(await codeOf(exportTranslation(dir, entry, undefined, 'ko', deps))).toBe('OUTPUT_MISSING')
    expect(dialog).not.toHaveBeenCalled()
  })

  it('refuses a destination inside the project source folder and writes nothing', async () => {
    const entry = await addSource('a.md')
    writeFileSync(join(dir, 'output', 'a.md'), 'translated')
    picked = join(dir, 'source', 'a (ko).md')
    expect(await codeOf(exportTranslation(dir, entry, undefined, 'ko', deps))).toBe('EXPORT_REFUSED')
    expect(existsSync(picked)).toBe(false)
    // overwriting the source copy itself is refused as well
    picked = join(dir, 'source', 'a.md')
    expect(await codeOf(exportTranslation(dir, entry, undefined, 'ko', deps))).toBe('EXPORT_REFUSED')
    expect(readFileSync(join(dir, 'source', 'a.md'), 'utf8')).toBe('source')
  })

  it('refuses the output file itself as the destination', async () => {
    const entry = await addSource('a.md')
    writeFileSync(join(dir, 'output', 'a.md'), 'translated')
    picked = join(dir, 'output', 'a.md')
    expect(await codeOf(exportTranslation(dir, entry, undefined, 'ko', deps))).toBe('EXPORT_REFUSED')
    expect(readFileSync(join(dir, 'output', 'a.md'), 'utf8')).toBe('translated')
  })

  it('asks to save first when the output editor has unsaved changes, without the dialog', async () => {
    const entry = await addSource('a.md')
    writeFileSync(join(dir, 'output', 'a.md'), 'translated')
    dirty = true
    picked = join(root, 'a (ko).md')
    expect(await exportTranslation(dir, entry, undefined, 'ko', deps)).toEqual({ status: 'unsaved' })
    expect(dialog).not.toHaveBeenCalled()
    expect(existsSync(picked)).toBe(false)
  })

  it('exports the newest translated PDF of a PDF source in the same format', async () => {
    const entry = await addSource('paper.pdf', Buffer.from('%PDF-1.4 fake'))
    writeFileSync(join(dir, 'output', 'paper.ko.pdf'), BYTES)
    picked = join(root, 'paper (ko).pdf')
    const result = await exportTranslation(dir, { ...entry, kind: 'pdf' }, undefined, 'ko', deps)
    expect(result.status).toBe('saved')
    expect(readFileSync(picked).equals(BYTES)).toBe(true)
    expect((dialog.mock.calls[0]![0] as { defaultPath: string }).defaultPath).toBe(
      join(dir, 'paper (ko).pdf'),
    )
  })

  it('refuses an output name that is not a result of that source', async () => {
    const entry = await addSource('a.md')
    writeFileSync(join(dir, 'output', 'a.md'), 'x')
    writeFileSync(join(root, 'secret.txt'), 'nope')
    expect(await codeOf(exportTranslation(dir, entry, '../../secret.txt', 'ko', deps))).toBe(
      'INVALID_ARGUMENT',
    )
  })
})
