import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import type { AiStreamRequest } from '@genoffice/ai-provider'
import { addGlossary, addSource, createProject, saveProject } from '@genoffice/translate-project'
import { createXmindDocumentFromOutline } from '@genoffice/xmind-engine'
import { appForPath, ROUTED_EXTENSIONS } from '../apps/shell/src/main/app-routing'
import { buildEditFixture } from '../apps/sheets/tests/fixture-builder'
import { buildEpub, epub3Files } from '../packages/epub-engine/tests/helpers'
import { buildOdt } from '../packages/odt-engine/tests/helpers/build-odt'
import { readHangulText } from './hwp-document-text'
import { batchRow, startBatchWithFiles } from './project-batch-ui'
import { queuePicks, queueTurns, recorded, stubEverything } from './project-folder-user-lib'
import { closeAndSaveVideo, launchShell, type LaunchedApp } from './helpers'

type Extension = (typeof ROUTED_EXTENSIONS)[keyof typeof ROUTED_EXTENSIONS][number]
type Fixture = {
  content: () => Promise<Uint8Array | string> | string
  check: (page: Page) => Promise<void>
}

const sample = (path: string) => readFile(resolve(__dirname, '..', path))
const bodyText = (selector: string, marker: string) => async (page: Page) => {
  await expect(page.locator(selector).first()).toContainText(marker)
}
const frameText = (selector: string, marker: string) => async (page: Page) => {
  await expect(page.frameLocator(selector).locator('body')).toContainText(marker)
}
const wordPage = '.doc-page[contenteditable="true"]'
const source = '.source-editor .cm-content'

const cell = (address: string, expected: string) => async (page: Page) => {
  await expect
    .poll(() =>
      page.evaluate((a1) => {
        const debug = (
          window as unknown as {
            __genofficeDebug?: {
              univerAPI: {
                getActiveWorkbook(): {
                  getActiveSheet(): { getRange(ref: string): { getValue(): unknown } } | null
                } | null
              }
            }
          }
        ).__genofficeDebug
        return debug?.univerAPI.getActiveWorkbook()?.getActiveSheet()?.getRange(a1).getValue()
      }, address),
    )
    .toBe(expected)
}

function hangul(extension: 'hwp' | 'hwpx'): Fixture {
  return {
    content: () => sample('apps/hwp/tests/fixtures/memo.' + extension),
    check: async (page) => {
      await expect(page.locator('.hwp-app')).toHaveAttribute('data-phase', 'ready', {
        timeout: 60_000,
      })
      expect(await readHangulText(page)).toContain('본문 메모 앵커')
    },
  }
}

// Excel permits a macro-enabled workbook without a VBA project. Use its
// actual main-part content type and the complete sample's package relationships.
async function macroEnabledWorkbook(): Promise<Uint8Array> {
  const book = await JSZip.loadAsync(
    await sample('packages/translate-project/src/__fixtures__/glossary.xlsx'),
  )
  const manifest = await book.file('[Content_Types].xml')!.async('string')
  const xlsxType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
  expect(manifest).toContain(xlsxType)
  book.file(
    '[Content_Types].xml',
    manifest.replace(xlsxType, 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'),
  )
  return book.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

const cases: Record<Extension, Fixture> = {
  docx: {
    content: () => sample('fixtures/generated/simple.docx'),
    check: bodyText(wordPage, '第一段。'),
  },
  odt: {
    content: () =>
      buildOdt({
        mimetypeFirst: true,
        officeVersion: '1.2',
        body: '<text:p>OpenDocument paragraph.</text:p>',
      }),
    check: bodyText(wordPage, 'OpenDocument paragraph.'),
  },
  xlsx: { content: buildEditFixture, check: cell('A1', 'Hello') },
  xlsm: { content: macroEnabledWorkbook, check: cell('B2', 'contract') },
  xls: {
    content: () => sample('apps/sheets/native/xlsx-engine/tests/fixtures/cell-styles.xls'),
    check: cell('A3', 'Chair'),
  },
  csv: { content: () => 'Item,Description\r\n1,"Red, blue"\r\n', check: cell('B2', 'Red, blue') },
  tsv: {
    content: () => 'Item\tDescription\r\n1\tLeft, right\r\n',
    check: cell('B2', 'Left, right'),
  },
  pptx: {
    content: () => sample('packages/pptx-engine/tests/fixtures/01_standard_business.pptx'),
    check: async (page) => {
      await page
        .locator('.ribbon-tab')
        .filter({ hasText: /^View$/ })
        .click()
      await page.getByRole('button', { name: 'Outline View', exact: true }).click()
      await expect(page.locator('.outline-body').first()).toContainText('Q3 Business Review')
    },
  },
  pdf: {
    content: async () => {
      const doc = await PDFDocument.create()
      doc.addPage([350, 200]).drawText('Quarterly PDF totals', { x: 20, y: 120 })
      return doc.save()
    },
    check: bodyText('.textLayer', 'Quarterly PDF totals'),
  },
  html: {
    content: () => '<!doctype html><h1>HTML article</h1>',
    check: frameText('.preview-frame', 'HTML article'),
  },
  htm: {
    content: () => '<!doctype html><p>Short extension article</p>',
    check: frameText('.preview-frame', 'Short extension article'),
  },
  xmind: {
    content: async () =>
      (
        await createXmindDocumentFromOutline('# Trip\n\n- Trip plan\n  - Train times\n', {
          untitled: 'Untitled',
        })
      ).save(),
    check: async (page) => {
      await expect(
        page
          .locator('.mm-sheet-host:not([hidden]) me-tpc > .text')
          .filter({ hasText: 'Train times' }),
      ).toHaveCount(1)
    },
  },
  hwp: hangul('hwp'),
  hwpx: hangul('hwpx'),
  epub: {
    content: () => buildEpub(epub3Files()),
    check: frameText('.epub-frame', 'First chapter.'),
  },
  md: {
    content: () => '# Field notes\n\nSample field observations.',
    check: bodyText('.doc-editor', 'Sample field observations.'),
  },
  markdown: {
    content: () => '# Observations\n\nLong extension notes.',
    check: bodyText('.doc-editor', 'Long extension notes.'),
  },
  txt: { content: () => 'Plain text line.\n', check: bodyText(source, 'Plain text line.') },
  json: {
    content: () => '{"project":"Northern survey"}\n',
    check: bodyText(source, 'Northern survey'),
  },
}

let launched: LaunchedApp
test.beforeAll(async () => {
  launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'supported-document-formats',
    env: { GENOFFICE_DEBUG_HOOKS: '1' },
  })
  await stubEverything(launched.app)
})
test.afterAll(async () => {
  if (!launched) return
  await closeAndSaveVideo(launched, 'supported-document-formats')
  await rm(launched.userDataDir, { recursive: true, force: true })
})

test('learns finished documents from one native multi-selection across all supported formats', async () => {
  const { app, page } = launched
  const paths: string[] = []
  for (const ext of Object.values(ROUTED_EXTENSIONS).flat()) {
    const path = test.info().outputPath('final.' + ext)
    await writeFile(path, await cases[ext].content())
    paths.push(path)
  }
  await queuePicks(app, [paths])
  await page.getByRole('button', { name: 'Learn from final documents' }).click()
  await expect(
    page.locator('.translate-learn-results li').filter({ hasText: 'Added to the wiki' }),
  ).toHaveCount(paths.length)
  const catalog = await readFile(
    join(launched.userDataDir, 'translation-wiki', 'vault', 'final-documents.md'),
    'utf8',
  )
  expect(catalog).toContain('final-documents/')
  const notes = await readdir(
    join(launched.userDataDir, 'translation-wiki', 'vault', 'final-documents'),
  )
  expect(notes).toHaveLength(paths.length)
  const empty = test.info().outputPath('empty.txt')
  await writeFile(empty, '   ')
  await queuePicks(app, [
    [test.info().outputPath('missing.txt'), empty, test.info().outputPath('final.docx')],
  ])
  expect(await page.evaluate(() => window.translateApi.learnFinals())).toEqual([
    { name: 'missing.txt', status: 'failed' },
    { name: 'empty.txt', status: 'empty' },
    { name: 'final.docx', status: 'duplicate' },
  ])
  expect(await page.evaluate(() => window.translateApi.learnFinals())).toEqual([])
})

// Default Playwright mode keeps a single shell in the passing path and runs
// the remaining extensions in a fresh worker if any one of them fails.
for (const ext of Object.values(ROUTED_EXTENSIONS).flat()) {
  test(`@release-smoke opens .${ext} through the shell and reads its document content`, async () => {
    const { content, check } = cases[ext]
    const path = test.info().outputPath('sample.' + ext)
    await writeFile(path, await content())
    // A closed Word tab keeps its detached WebContents. Capture the newly
    // opened renderer so consecutive .docx and .odt cases read their own page.
    const [page] = await Promise.all([
      launched.app.waitForEvent('window'),
      launched.page.evaluate((p) => window.aiOffice.openPath(p), path),
    ])
    const tab = launched.page.locator('.tab-item.active:not(.tab-home)')
    await expect(tab.locator('.tab-title')).toHaveText('sample.' + ext)
    await expect
      .poll(() => page.evaluate(() => location.href).catch(() => ''))
      .toContain('://' + appForPath(path) + '/')
    await check(page)
    await test.step('whole-document translation starts with the editor’s source-reading tools', async () => {
      await queueTurns(launched.app, [
        {
          toolCalls: [
            {
              id: 'prepare',
              name: 'prepare_document_translation',
              input: { targetLanguage: 'Korean' },
            },
          ],
        },
        { text: 'SOURCE_READING_CHECK' },
      ])
      const composer = page.locator('.ai-composer textarea').first()
      if (!(await composer.isVisible())) await page.locator('.ai-rail').first().click()
      await composer.fill('Translate the entire current document into Korean in place.')
      await page.locator('.ai-composer .ai-send-btn').first().click()
      await expect(page.getByText('SOURCE_READING_CHECK', { exact: true }).last()).toBeVisible()
      const request = JSON.parse((await recorded(launched.app)).streams.at(-1)!)
      const tools: string[] = request.tools.map((tool: { name: string }) => tool.name)
      expect(tools).toContain('record_source_overview')
      expect(tools).not.toContain('prepare_document_translation')
      expect(tools.some((name) => name.startsWith('read_'))).toBe(true)
    })
    await tab.locator('.tab-close').click()
    await expect(launched.page.locator('.tab-item:not(.tab-home)')).toHaveCount(0)
  })
}

// The read tool gets real data from the editor before the model proposes a single change.
async function formatEdit(
  ext: Exclude<Extension, 'pdf'>,
  original: string,
  value: string,
): Promise<[string, Record<string, unknown>]> {
  switch (ext) {
    case 'docx':
    case 'odt':
      return [
        'replace_blocks',
        { startBlockIndex: 0, endBlockIndex: 0, html: '<p>' + value + '</p>' },
      ]
    case 'xls':
    case 'xlsx':
    case 'xlsm':
    case 'csv':
    case 'tsv':
      return [
        'propose_operations',
        {
          translation: true,
          summary: 'Translate the header',
          operations: [{ op: 'set_cell', sheetId: 'sheet-1', address: 'A1', value }],
        },
      ]
    case 'pptx':
      return [
        'apply_ops',
        { translation: true, ops: [{ op: 'setNotes', target: { slide: 0 }, text: value }] },
      ]
    case 'md':
    case 'markdown':
      return [
        'apply_ops',
        {
          intent: 'translation',
          ops: [
            {
              op: 'replaceText',
              target: { start: 0 },
              find: ext === 'md' ? 'Field notes' : 'Observations',
              replace: value,
            },
          ],
        },
      ]
    case 'txt':
    case 'json':
      return [
        'translate_source_units',
        {
          language: 'English',
          items: [
            {
              id: 0,
              source: ext === 'txt' ? 'Plain text line.' : 'Northern survey',
              translation: value,
            },
          ],
        },
      ]
    case 'html':
    case 'htm':
      return [
        'apply_ops',
        {
          intent: 'translation',
          ops: [
            {
              op: 'str_replace',
              old: ext === 'html' ? 'HTML article' : 'Short extension article',
              new: value,
            },
          ],
        },
      ]
    case 'hwp':
    case 'hwpx':
      return ['replace_text', { find: '본문 메모 앵커', replace: value, occurrence: 1 }]
    case 'xmind': {
      const zip = await JSZip.loadAsync(await readFile(original))
      const sheet = JSON.parse(await zip.file('content.json')!.async('string'))[0]
      return [
        'edit_map',
        {
          intent: 'translation',
          edits: [{ op: 'set_title', id: sheet.rootTopic.id, title: value }],
        },
      ]
    }
    case 'epub':
      return ['edit_blocks', { ops: [{ op: 'replace', chapter: 1, blockId: 'b1', text: value }] }]
  }
}

test('project batch inspects and saves every editable file format with the project in front', async () => {
  test.skip(
    process.env.E2E_PROJECT_BATCH_FORMATS !== '1',
    'Run the cross-editor write and save matrix on demand.',
  )
  test.setTimeout(240_000)
  const parent = test.info().outputPath('batch-formats')
  await mkdir(parent, { recursive: true })
  const { dir, project } = await createProject(parent, 'Project format checks', 'ko', 'en')
  const styleGuide = 'Use the Northern Survey house style.'
  const targetTerm = 'Northern Mission Delegation'
  await saveProject(dir, { ...project, projectPrompt: styleGuide })
  const glossary = join(parent, 'terms.csv')
  await writeFile(glossary, 'source,target\n조사단,' + targetTerm)
  await addGlossary(dir, glossary)
  const formats = Object.values(ROUTED_EXTENSIONS)
    .flat()
    .filter((ext) => ext !== 'pdf')
  const reads: Record<Exclude<Extension, 'pdf'>, [string, Record<string, unknown>]> = {
    docx: ['read_blocks', { startBlockIndex: 0, endBlockIndex: 0 }],
    odt: ['read_blocks', { startBlockIndex: 0, endBlockIndex: 0 }],
    xlsx: ['read_range', { range: 'A1:B3' }],
    xlsm: ['read_range', { range: 'A1:B3' }],
    xls: ['read_range', { range: 'A1:B3' }],
    csv: ['read_range', { range: 'A1:B2' }],
    tsv: ['read_range', { range: 'A1:B2' }],
    pptx: ['read_slide', { slideIndex: 0 }],
    md: ['read_blocks', { startIndex: 0, endIndex: 0 }],
    markdown: ['read_blocks', { startIndex: 0, endIndex: 0 }],
    txt: ['read_source_units', { language: 'English' }],
    json: ['read_source_units', { language: 'English' }],
    html: ['read_source', {}],
    htm: ['read_source', {}],
    hwp: ['read_document', {}],
    hwpx: ['read_document', {}],
    xmind: ['read_map', {}],
    epub: ['read_chapter', { chapter: 1 }],
  }
  for (const ext of formats) {
    const path = join(parent, 'fixture.' + ext)
    await writeFile(path, await cases[ext].content())
    await addSource(dir, path)
  }
  const { app, page } = launched
  const example = 'The mission welcomes visiting delegates.'
  const finished = join(parent, 'approved.txt')
  await writeFile(finished, example)
  await queuePicks(app, [[finished]])
  await page.getByRole('button', { name: 'Learn from final documents' }).click()
  await expect(page.locator('.translate-learn-results')).toContainText('approved.txt')
  const notesDir = join(launched.userDataDir, 'translation-wiki', 'vault', 'final-documents')
  const note = (await readdir(notesDir)).find((file) => file.startsWith('approved_txt-'))!
  await queuePicks(app, [dir, [join(notesDir, note)]])
  await page.getByRole('button', { name: 'Open existing project folder' }).click()
  await page.getByRole('button', { name: 'Choose wiki references' }).click()
  await expect(page.getByText(note, { exact: true }).first()).toBeVisible()
  await expect(page.getByTestId('project-batch-start')).toBeVisible()
  // Intercept only the model. Real editor tools, disk persistence, project focus,
  // the XLS/TSV conversion and Electron IPC all run on the production paths.
  const failures: string[] = []
  for (const ext of formats) {
    await test.step('.' + ext, async () => {
      const file = 'fixture.' + ext
      const [name, input] = reads[ext]
      const value = 'Translated ' + ext + ' specimen'
      const [edit, args] = await formatEdit(ext, join(parent, file), value)
      const before = (await recorded(app)).streams.length
      await app.evaluate(() => {
        ;(globalThis as Record<string, unknown>).__pfTurns = []
      })
      await queueTurns(app, [
        { toolCalls: [{ id: 'inspect-' + ext, name, input }] },
        { toolCalls: [{ id: 'edit-' + ext, name: edit, input: args }] },
        { text: 'PROJECT_TRANSLATION_COMPLETE' },
      ])
      const progress = await startBatchWithFiles(page, [file])
      await expect(batchRow(progress, file)).toHaveAttribute(
        'data-batch-state',
        /^(saved|failed|stopped)$/,
        { timeout: 135_000 },
      )
      const item = (await page.evaluate(
        (d) => window.translateApi.batchStatus(d),
        dir,
      ))!.items.find((i) => i.file === file)!
      await progress.getByTestId('project-batch-close').click()
      const calls: AiStreamRequest[] = (await recorded(app)).streams
        .slice(before)
        .map((text) => JSON.parse(text))
      const results =
        calls
          .at(-1)
          ?.messages.flatMap((message) => (message.role === 'tool' ? message.results : [])) ?? []
      const reading = results.find((result) => result.id === 'inspect-' + ext)
      const writing = results.find((result) => result.id === 'edit-' + ext)
      if (
        item.state !== 'saved' ||
        !reading?.output ||
        reading.isError ||
        !writing?.output ||
        writing.isError
      ) {
        failures.push(
          ext +
            ': ' +
            (writing?.isError
              ? writing.output
              : (item.error ?? reading?.output ?? 'no successful document edit')),
        )
        return
      }
      const prompt = JSON.stringify(calls[0])
      expect.soft(prompt.includes(styleGuide), ext + ' received the project prompt').toBe(true)
      expect.soft(prompt.includes(example), ext + ' received the selected wiki example').toBe(true)
      expect.soft(prompt.includes(targetTerm), ext + ' received the project glossary').toBe(true)
      const output = await readFile(join(dir, 'output', item.output!))
      if (['xls', 'tsv'].includes(ext)) expect(item.output).toBe(file + '.xlsx')
      if (
        ['docx', 'odt', 'xlsx', 'xls', 'tsv', 'xlsm', 'pptx', 'hwpx', 'epub', 'xmind'].includes(ext)
      ) {
        const zip = await JSZip.loadAsync(output)
        expect(Object.keys(zip.files).length).toBeGreaterThan(1)
        if (ext === 'xlsm')
          expect(await zip.file('[Content_Types].xml')!.async('string')).toContain('macroEnabled')
        const parts = Object.values(zip.files).filter((entry) =>
          /\.(?:xml|json|html|xhtml)$/i.test(entry.name),
        )
        const body = (await Promise.all(parts.map((entry) => entry.async('string')))).join('\n')
        expect
          .soft(body.includes(value), ext + ' preserves the translated text after serialization')
          .toBe(true)
      } else if (ext === 'hwp') {
        expect(output.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1')
        const read = execFileSync(
          process.execPath,
          [
            resolve(__dirname, '../packages/cli/dist/genoffice.cjs'),
            'hwp',
            'read',
            join(dir, 'output', item.output!),
          ],
          { encoding: 'utf8' },
        )
        expect.soft(read).toContain(value)
      } else {
        expect.soft(output.toString('utf8')).toContain(value)
        if (ext === 'csv') expect(output.toString('utf8')).toContain('"Red, blue"')
      }
      expect(await readFile(join(dir, 'source', file))).toEqual(await readFile(join(parent, file)))
      await expect(page.getByTestId('project-batch-start')).toBeVisible()
      await expect(page.locator('.tab-item.active:not(.tab-home)')).toHaveCount(0)
    })
  }
  expect(failures).toEqual([])
  // A resumed TXT/JSON job can find its saved outputs already translated.
  await queueTurns(
    app,
    ['txt', 'json'].flatMap((ext) => [
      {
        toolCalls: [
          { id: 'resume-' + ext, name: 'read_source_units', input: { language: 'English' } },
        ],
      },
      { text: 'PROJECT_ALREADY_TRANSLATED\nPROJECT_TRANSLATION_COMPLETE' },
    ]),
  )
  const progress = await startBatchWithFiles(page, ['fixture.txt', 'fixture.json'])
  for (const file of ['fixture.txt', 'fixture.json']) {
    await expect(batchRow(progress, file)).toHaveAttribute('data-batch-state', 'saved', {
      timeout: 90_000,
    })
  }
  await progress.getByTestId('project-batch-close').click()
})

test('a Word chat change link selects the paragraph the mock edited', async () => {
  const path = test.info().outputPath('change-link.docx')
  await writeFile(path, await cases.docx.content())
  const [page] = await Promise.all([
    launched.app.waitForEvent('window'),
    launched.page.evaluate((p) => window.aiOffice.openPath(p), path),
  ])
  await cases.docx.check(page)
  const marker = 'Revised visit schedule.'
  await queueTurns(launched.app, [
    {
      toolCalls: [
        {
          id: 'revise',
          name: 'replace_blocks',
          input: { startBlockIndex: 1, endBlockIndex: 1, html: '<p>' + marker + '</p>' },
        },
      ],
    },
    { text: 'Revision complete.' },
  ])
  const composer = page.locator('.ai-composer textarea').first()
  if (!(await composer.isVisible())) await page.locator('.ai-rail').first().click()
  await composer.fill('Replace the second paragraph with the revised visit schedule.')
  await page.locator('.ai-composer .ai-send-btn').first().click()
  await expect(page.getByText('Revision complete.', { exact: true })).toBeVisible()
  const links = page.locator('.ai-change-links')
  await links.locator('summary').click()
  await links.getByRole('button', { name: '#2', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toContain(marker)
  await page.keyboard.press('ControlOrMeta+s')
})
