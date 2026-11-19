import { expect, test, type Page } from '@playwright/test'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import JSZip from 'jszip'
import { PDFDocument } from 'pdf-lib'
import { createXmindDocumentFromOutline } from '@genoffice/xmind-engine'
import { appForPath, ROUTED_EXTENSIONS } from '../apps/shell/src/main/app-routing'
import { buildEditFixture } from '../apps/sheets/tests/fixture-builder'
import { buildEpub, epub3Files } from '../packages/epub-engine/tests/helpers'
import { buildOdt } from '../packages/odt-engine/tests/helpers/build-odt'
import { readHangulText } from './hwp-document-text'
import { queueTurns, recorded, stubEverything } from './project-folder-user-lib'
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
