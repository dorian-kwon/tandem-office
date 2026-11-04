import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, importSource, type SourceEntry } from '@genoffice/translate-project'
import {
  openTranslation,
  openTranslationResult,
  type TranslationViewDeps,
} from '../src/main/translate/open-translation'
import { parseTranslateError } from '../src/shared/translate-api'

let root: string
let dir: string
let opened: string[]
let deps: TranslationViewDeps & {
  openTab: ReturnType<typeof vi.fn>
  setTabReadOnly: ReturnType<typeof vi.fn>
  showSplit: ReturnType<typeof vi.fn>
  closeTab: ReturnType<typeof vi.fn>
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'open-translation-'))
  dir = (await createProject(root, 'P', 'en', 'ko')).dir
  opened = []
  deps = {
    openTab: vi.fn((path: string) => {
      opened.push(path)
      return { tabId: `t-${opened.length}`, created: true }
    }),
    closeTab: vi.fn(),
    setTabReadOnly: vi.fn(() => true),
    showSplit: vi.fn(),
    setPaneHidden: vi.fn(() => true),
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function addSource(name: string, text: string): Promise<SourceEntry> {
  const original = join(root, name)
  writeFileSync(original, text)
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

it.each(['docx', 'xlsx'])(
  'opens a generated OCR document in the original %s format',
  async (ext) => {
    const entry = await addSource(`a.${ext}`, 'source')
    writeFileSync(join(dir, 'output', `a (OCR).${ext}`), 'ocr result')
    const result = await openTranslationResult(dir, entry, `a (OCR).${ext}`, deps)
    expect(result.sourceTabId).not.toBeNull()
    expect(opened).toEqual([join(dir, 'source', `a.${ext}`), join(dir, 'output', `a (OCR).${ext}`)])
    expect(deps.setTabReadOnly).toHaveBeenCalled()
    expect(deps.showSplit).toHaveBeenCalled()
  },
)

describe('openTranslation', () => {
  it('opens the source copy read-only on the left and the output copy on the right', async () => {
    const entry = await addSource('a.md', '# hello')
    const result = await openTranslation(dir, entry, deps)
    expect(opened).toEqual([join(dir, 'source', 'a.md'), join(dir, 'output', 'a.md')])
    expect(deps.setTabReadOnly).toHaveBeenCalledWith('t-1')
    expect(deps.setTabReadOnly).not.toHaveBeenCalledWith('t-2')
    expect(deps.showSplit).toHaveBeenCalledWith('t-1', 't-2')
    expect(result).toEqual({
      flow: 'edit',
      sourceTabId: 't-1',
      outputTabId: 't-2',
      hashStatus: 'ok',
    })
  })

  it('creates output copy once and reuses it on reopen', async () => {
    const entry = await addSource('a.md', '# hello')
    await openTranslation(dir, entry, deps)
    const output = join(dir, 'output', 'a.md')
    expect(readFileSync(output, 'utf8')).toBe('# hello')
    // the person edits the output copy, then opens the translation again
    writeFileSync(output, '# 안녕')
    await openTranslation(dir, entry, deps)
    expect(readFileSync(output, 'utf8')).toBe('# 안녕')
  })

  it('output copy keeps the original extension', async () => {
    const entry = await addSource('Report.Final.DOCX', 'bytes')
    await openTranslation(dir, entry, deps)
    expect(existsSync(join(dir, 'output', 'Report.Final.DOCX'))).toBe(true)
    expect(opened[1]).toBe(join(dir, 'output', 'Report.Final.DOCX'))
  })

  it('hash changed returns hashStatus changed and still opens the source copy', async () => {
    const entry = await addSource('a.md', '# hello')
    writeFileSync(join(dir, 'source', 'a.md'), '# tampered')
    const result = await openTranslation(dir, entry, deps)
    expect(result.hashStatus).toBe('changed')
    expect(opened[0]).toBe(join(dir, 'source', 'a.md'))
    expect(deps.setTabReadOnly).toHaveBeenCalledWith('t-1')
    expect(deps.showSplit).toHaveBeenCalled()
  })

  it('rejects a missing source copy without opening or copying anything', async () => {
    const entry = await addSource('a.md', '# hello')
    rmSync(join(dir, 'source', 'a.md'))
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('SOURCE_MISSING')
    expect(opened).toEqual([])
    expect(existsSync(join(dir, 'output', 'a.md'))).toBe(false)
  })

  it('routes a text PDF to the translation job and opens nothing', async () => {
    const entry = await addSource('a.pdf', '%PDF-1.4')
    expect(await openTranslation(dir, entry, deps)).toEqual({
      flow: 'translate-pdf',
      file: 'a.pdf',
      hashStatus: 'ok',
      existing: null,
    })
    expect(opened).toEqual([])
  })

  it.each(['scan', 'image'] as const)('routes a %s source to OCR when OCR is on', async (kind) => {
    const name = kind === 'scan' ? 'a.pdf' : 'a.png'
    const entry = { ...(await addSource(name, 'bytes')), kind }
    const result = await openTranslation(dir, entry, deps, {
      ocr: { kind: 'ai', provider: 'claude' },
    })
    expect(result).toEqual({ flow: 'ocr', kind, file: name, hashStatus: 'ok', existing: null })
    expect(opened).toEqual([])
  })

  it.each(['scan', 'image'] as const)('refuses a %s source with OCR off', async (kind) => {
    const entry: SourceEntry = { file: kind === 'scan' ? 'a.pdf' : 'a.png', sha256: 'x', kind }
    expect(await codeOf(openTranslation(dir, entry, deps, { ocr: { kind: 'off' } }))).toBe(
      'OCR_DISABLED',
    )
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OCR_DISABLED')
    expect(opened).toEqual([])
  })

  it('refuses an image type the OCR cannot read', async () => {
    const entry: SourceEntry = { file: 'a.gif', sha256: 'x', kind: 'image' }
    const ocr = { kind: 'ai', provider: 'claude' } as const
    expect(await codeOf(openTranslation(dir, entry, deps, { ocr }))).toBe('UNSUPPORTED_SOURCE')
  })

  it('names an earlier translated PDF only in the current target language', async () => {
    const entry = await addSource('a.pdf', 'bytes')
    mkdirSync(join(dir, 'output'), { recursive: true })
    writeFileSync(join(dir, 'output', 'a.fr.pdf'), 'x')
    writeFileSync(join(dir, 'output', 'a.final.pdf'), 'x')
    expect(await openTranslation(dir, entry, deps, { targetLang: 'ko' })).toMatchObject({
      existing: null,
    })
    writeFileSync(join(dir, 'output', 'a.ko.bilingual.pdf'), 'x')
    expect(await openTranslation(dir, entry, deps, { targetLang: 'ko' })).toMatchObject({
      existing: 'a.ko.bilingual.pdf',
    })
    expect(await openTranslation(dir, entry, deps, { targetLang: 'fr' })).toMatchObject({
      existing: 'a.fr.pdf',
    })
  })

  it('names the newest earlier OCR result of a scan', async () => {
    const entry = { ...(await addSource('a.pdf', 'bytes')), kind: 'scan' as const }
    mkdirSync(join(dir, 'output'), { recursive: true })
    writeFileSync(join(dir, 'output', 'a (OCR).docx'), 'x')
    writeFileSync(join(dir, 'output', 'b (OCR).docx'), 'x')
    const result = await openTranslation(dir, entry, deps, {
      ocr: { kind: 'ai', provider: 'chatgpt' },
    })
    expect(result).toMatchObject({ existing: 'a (OCR).docx' })
  })

  it('rejects a file name that leaves the source folder', async () => {
    for (const file of ['../a.md', 'sub/a.md', '..', '']) {
      const entry: SourceEntry = { file, sha256: 'x', kind: 'editable' }
      expect(await codeOf(openTranslation(dir, entry, deps))).toBe('INVALID_ARGUMENT')
    }
    expect(opened).toEqual([])
  })

  it('rejects an editable kind no editor opens (ods listed by an older version)', async () => {
    // import refuses .ods now; a project made before that may still list one
    const copy = await addSource('sheet.txt', 'bytes')
    renameSync(join(dir, 'source', copy.file), join(dir, 'source', 'sheet.ods'))
    const entry: SourceEntry = { ...copy, file: 'sheet.ods' }
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('UNSUPPORTED_SOURCE')
    expect(opened).toEqual([])
  })

  it('reports a tab that did not land in the strip', async () => {
    const entry = await addSource('a.md', '# hello')
    deps.openTab = vi.fn(() => undefined)
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OPEN_FAILED')
    expect(deps.showSplit).not.toHaveBeenCalled()
  })

  it('does not show the split when the source tab cannot be made read-only', async () => {
    const entry = await addSource('a.md', '# hello')
    deps.setTabReadOnly.mockImplementation(() => false)
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OPEN_FAILED')
    expect(deps.showSplit).not.toHaveBeenCalled()
  })
})

describe('openTranslation (review fixes)', () => {
  it('refuses an output path that is a folder', async () => {
    const entry = await addSource('a.md', '# hello')
    mkdirSync(join(dir, 'output', 'a.md'), { recursive: true })
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OPEN_FAILED')
    expect(opened).toEqual([])
  })

  it('closes the source tab it opened when the output copy cannot open', async () => {
    const entry = await addSource('a.md', '# hello')
    deps.openTab.mockImplementation((path: string) =>
      path.includes('output') ? undefined : { tabId: 'src', created: true },
    )
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OPEN_FAILED')
    expect(deps.closeTab).toHaveBeenCalledWith('src')
    expect(deps.showSplit).not.toHaveBeenCalled()
  })

  it('leaves a source tab that was already open before this call', async () => {
    const entry = await addSource('a.md', '# hello')
    deps.openTab.mockImplementation((path: string) =>
      path.includes('output') ? undefined : { tabId: 'src', created: false },
    )
    expect(await codeOf(openTranslation(dir, entry, deps))).toBe('OPEN_FAILED')
    expect(deps.closeTab).not.toHaveBeenCalled()
  })
})
