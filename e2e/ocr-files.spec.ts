import { test, expect, type Page } from '@playwright/test'
import { DOMParser } from '@xmldom/xmldom'
import { Document, ImageRun, Packer, PageBreak, Paragraph } from 'docx'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import JSZip from 'jszip'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { writeOfficeTableFixtures } from './ocr-office-fixtures'
import { searchablePageTexts, searchableText } from './ocr-pdf-text'

async function dropFiles(page: Page, paths: string[]) {
  // Chromium-backed Files from a real file input carry native paths in Electron.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.dataset.testid = 'native-drop-source'
    document.body.append(input)
  })
  const dropped = page.getByTestId('native-drop-source')
  await dropped.setInputFiles(paths)
  await dropped.evaluate((el: HTMLInputElement) => {
    const transfer = new DataTransfer()
    for (const file of el.files!) transfer.items.add(file)
    document
      .querySelector('[data-testid="ocr-files-panel"]')!
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      )
    el.remove()
  })
}

test('OCR menu writes a searchable PDF and an editable Word from a local image', async () => {
  test.skip(process.env.TANDEM_TEST_LOCAL_OCR !== '1', 'Requires a supported native OCR helper')
  const folder = test.info().outputPath('ocr')
  await mkdir(folder, { recursive: true })
  const png = join(folder, 'scan.png')
  const custom = process.env.TANDEM_OCR_SMOKE_IMAGE
  await copyFile(
    custom ?? join(__dirname, '../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png'),
    png,
  )
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'ocr',
  })
  try {
    await launched.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, png)
    const { page } = launched
    await page.getByTestId('home-ocr-nav').click()
    await page.getByTestId('ocr-files-pick').click()
    const row = page.getByTestId('ocr-files-file')
    for (const target of ['pdf', 'docx']) {
      await page.getByTestId('ocr-files-target').selectOption(target)
      await page.getByTestId('ocr-files-run').click()
      const output = join(folder, 'scan OCR.' + target)
      await expect(row).toContainText(output, { timeout: 30_000 })
      const bytes = await readFile(output)
      if (target === 'pdf') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      else {
        const zip = await JSZip.loadAsync(bytes)
        const xml = await zip.file('word/document.xml')!.async('string')
        expect(xml).toContain('<w:t')
        if (custom) {
          expect(xml).toContain('부산')
          expect(xml).toContain('Busan')
          expect(xml).toContain('<w:tbl>')
          expect(xml).toContain('<w:drawing>')
        }
      }
    }
  } finally {
    await closeAndSaveVideo(launched, 'ocr')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

test('batch OCR writes a searchable copy beside each selected scan PDF', async () => {
  test.skip(process.env.TANDEM_TEST_LOCAL_OCR !== '1', 'Requires a supported native OCR helper')
  const pdf = await PDFDocument.create()
  const image = await pdf.embedPng(
    await readFile(join(__dirname, '../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png')),
  )
  pdf.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0 })
  const original = Buffer.from(await pdf.save())
  const inputs = []
  for (const name of ['first', 'second']) {
    const folder = test.info().outputPath(name)
    await mkdir(folder, { recursive: true })
    const path = join(folder, 'scan.pdf')
    await writeFile(path, original)
    inputs.push(path)
  }
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'batch-ocr',
    lang: 'ko',
  })
  try {
    await launched.app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
      },
      inputs.slice(0, 1),
    )
    const { page } = launched
    await page.getByTestId('home-ocr-nav').click()
    await page.getByTestId('ocr-files-pick').click()
    const rows = page.getByTestId('ocr-files-file')
    await expect(rows).toHaveCount(1)
    await dropFiles(page, [inputs[1]!])
    await expect(rows).toHaveCount(2)
    await page.getByTestId('ocr-page-range').fill('1')
    await page.getByTestId('ocr-files-language').selectOption('en-US')
    await page.getByTestId('ocr-files-target').selectOption('pdf')
    await page.getByRole('button', { name: '일괄 OCR 시작' }).click()
    for (const path of inputs) {
      const output = path.replace(/scan\.pdf$/, 'scan OCR.pdf')
      await expect(rows.filter({ hasText: output })).toHaveCount(1, { timeout: 30_000 })
      const result = await PDFDocument.load(await readFile(output))
      expect(
        result.getPages()[0].node.Resources()?.lookup(PDFName.of('Font'), PDFDict)?.keys().length,
      ).toBeGreaterThan(0)
      expect((await readFile(path)).equals(original)).toBe(true)
    }
  } finally {
    await closeAndSaveVideo(launched, 'batch-ocr')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

test('batch OCR keeps editable native and scanned tables in Word and Hangul documents', async () => {
  test.skip(process.env.TANDEM_TEST_LOCAL_OCR !== '1', 'Requires a supported native OCR helper')
  test.setTimeout(120_000)
  const folder = test.info().outputPath('office-tables')
  await mkdir(folder, { recursive: true })
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'office-ocr',
    lang: 'ko',
  })
  try {
    const { page } = launched
    const inputs = await writeOfficeTableFixtures(page, folder)
    const originals = await Promise.all(inputs.map((path) => readFile(path)))
    await launched.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, inputs[0]!)
    await page.getByTestId('home-ocr-nav').click()
    await page.getByTestId('ocr-files-pick').click()
    await dropFiles(page, inputs.slice(1))
    const rows = page.getByTestId('ocr-files-file')
    await expect(rows).toHaveCount(3)
    await page.getByTestId('ocr-files-language').selectOption('en-US')
    for (const target of ['docx', 'pdf']) {
      await page.getByTestId('ocr-files-target').selectOption(target)
      await page.getByTestId('ocr-files-run').click()
      for (const path of inputs) {
        const word = extname(path) === '.docx'
        const output = join(folder, basename(path, extname(path)) + ' OCR.' + target)
        const row = rows.filter({ has: page.getByText(basename(path), { exact: true }) })
        await expect(row).toContainText(output, { timeout: 45_000 })
        const bytes = await readFile(output)
        if (target === 'pdf') {
          const text = await searchableText(bytes)
          for (const term of word
            ? ['Nativemergedheader', 'Busan', '98765']
            : ['교과협의록', '성취도', 'Busan', '98765'])
            expect(text).toContain(term)
          continue
        }
        const pkg = await JSZip.loadAsync(bytes)
        const xml = await pkg.file('word/document.xml')!.async('string')
        const doc = new DOMParser().parseFromString(xml, 'application/xml')
        const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        const tables = Array.from(doc.getElementsByTagNameNS(w, 'tbl'))
        const nested = tables[0]?.getElementsByTagNameNS(w, 'tbl')
        expect(nested?.length).toBeGreaterThanOrEqual(word ? 1 : 3)
        expect(doc.getElementsByTagNameNS(w, 'gridSpan').length).toBeGreaterThan(0)
        if (word) {
          expect(tables[0]?.textContent).toContain('Native merged header')
        } else {
          expect(doc.getElementsByTagNameNS(w, 'vMerge').length).toBeGreaterThan(0)
          expect(tables[0]?.textContent).toContain('성취도')
        }
        const scan = tables.find((table) => {
          const cells = Array.from(table.getElementsByTagNameNS(w, 'tc'), (cell) =>
            cell.textContent?.trim(),
          )
          return cells.join('|') === 'Region|Count|Busan|98765'
        })
        expect(scan, 'Expected four independently editable OCR table cells').toBeDefined()
      }
    }
    for (const [i, path] of inputs.entries()) expect(await readFile(path)).toEqual(originals[i])
  } finally {
    await closeAndSaveVideo(launched, 'office-ocr')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

test('Word OCR page range recognizes the scan on the selected physical page only', async () => {
  test.skip(process.env.TANDEM_TEST_LOCAL_OCR !== '1', 'Requires a supported native OCR helper')
  test.setTimeout(60_000)
  const folder = test.info().outputPath('office-pages')
  await mkdir(folder, { recursive: true })
  const png = await readFile(
    join(__dirname, '../packages/pdf2docx/ocr-helper/fixtures/smoke-en.png'),
  )
  const scannedParagraph = () =>
    new Paragraph({
      children: [
        new ImageRun({
          type: 'png',
          data: png,
          transformation: { width: 415, height: 150 },
        }),
      ],
    })
  const docx = new Document({
    sections: [
      {
        children: [
          new Paragraph('FirstPage'),
          scannedParagraph(),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph('SecondPage'),
          scannedParagraph(),
        ],
      },
    ],
  })
  const original = await Packer.toBuffer(docx)
  const input = join(folder, 'pages.docx')
  await writeFile(input, original)
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'office-range',
  })
  try {
    const { page } = launched
    await page.getByTestId('home-ocr-nav').click()
    await dropFiles(page, [input])
    await page.getByTestId('ocr-page-range').fill('2')
    await page.getByTestId('ocr-files-language').selectOption('en-US')
    await page.getByTestId('ocr-files-target').selectOption('pdf')
    await page.getByTestId('ocr-files-run').click()
    const output = join(folder, 'pages OCR.pdf')
    await expect(page.getByTestId('ocr-files-file')).toContainText(output, { timeout: 30_000 })
    const texts = await searchablePageTexts(await readFile(output))
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('FirstPage')
    expect(texts[0]).not.toContain('12345')
    expect(texts[1]).toContain('SecondPage')
    expect(texts[1]).toContain('12345')
    expect(await readFile(input)).toEqual(original)
  } finally {
    await closeAndSaveVideo(launched, 'office-range')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

async function expectEditorOcrTable(path: string, keepScan: boolean) {
  const zip = await JSZip.loadAsync(await readFile(path))
  const xml = await zip.file('word/document.xml')!.async('string')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const nativeTable = doc.getElementsByTagNameNS(ns, 'tbl')[0]!
  expect(nativeTable.textContent).toContain('Native merged header')
  expect(nativeTable.getElementsByTagNameNS(ns, 'gridSpan').length).toBeGreaterThan(0)
  const nested = Array.from(nativeTable.getElementsByTagNameNS(ns, 'tbl'))
  expect(
    nested.some(
      (table) =>
        Array.from(table.getElementsByTagNameNS(ns, 'tc'), (cell) => cell.textContent?.trim()).join(
          '|',
        ) === 'Region|Count|Busan|98765',
    ),
  ).toBe(true)

  const drawings = nativeTable.getElementsByTagNameNS(ns, 'drawing')
  expect(drawings).toHaveLength(keepScan ? 1 : 0)
  if (keepScan) expect(xml.indexOf('</w:drawing>')).toBeLessThan(xml.indexOf('Region'))
}

async function editorLocation(app: Awaited<ReturnType<typeof launchShell>>['app']) {
  let location: Page | undefined
  await expect
    .poll(async () => {
      for (const candidate of app.context().pages()) {
        if (
          await candidate
            .getByTestId('editor-ocr-location')
            .count()
            .catch(() => 0)
        ) {
          location = candidate
          return true
        }
      }
      return false
    })
    .toBe(true)
  return location!
}

test('OCR in an open editor preserves native and scanned tables and opens the resulting copy', async () => {
  test.skip(process.env.TANDEM_TEST_LOCAL_OCR !== '1', 'Requires a supported native OCR helper')
  const folder = test.info().outputPath('editor-ocr')
  await mkdir(folder, { recursive: true })
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'editor-ocr',
    lang: 'en',
  })
  try {
    const { app, page } = launched
    const [input] = await writeOfficeTableFixtures(page, folder)
    const original = await readFile(input!)
    const output = join(folder, basename(input!, '.docx') + ' (OCR).docx')
    const button = page.getByTestId('document-ocr')
    await expect(button).toHaveCount(0)
    await page.evaluate((path) => window.aiOffice.openPath(path), input!)
    await expect(button).toBeEnabled()
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async function (...args) {
        const options = args.at(-1) as Electron.MessageBoxOptions
        return {
          response: options.cancelId ?? (options.buttons?.length ?? 1) - 1,
          checkboxChecked: false,
        }
      }
    })
    await button.click()
    await expect(button).toBeEnabled()
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async function (...args) {
        const options = args.at(-1) as Electron.MessageBoxOptions
        return { response: options.defaultId ?? 0, checkboxChecked: false }
      }
    })
    await button.click()
    const replace = await editorLocation(app)
    await expect(replace.locator('#location')).toHaveValue('Replace the image with the result')
    await replace.locator('#next').click()

    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.aiOfficeTabs.list()).find((tab) => tab.active)?.filePath,
          ),
        { timeout: 30_000 },
      )
      .toBe(output)
    expect(await readFile(input!)).toEqual(original)
    await expectEditorOcrTable(output, false)

    await page.evaluate(async (path) => {
      const source = (await window.aiOfficeTabs.list()).find((tab) => tab.filePath === path)
      if (!source) throw new Error('Original tab is missing')
      await window.aiOfficeTabs.activate(source.id)
    }, input!)
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async function (...args) {
        const options = args.at(-1) as Electron.MessageBoxOptions
        const apply =
          options.buttons?.findIndex(
            (label) => label === 'Apply to current file (keep a backup)',
          ) ?? -1
        return { response: apply >= 0 ? apply : 0, checkboxChecked: false }
      }
    })
    await button.click()
    const below = await editorLocation(app)
    await below.locator('[data-kind="docx-after-images"]').click()
    await below.locator('#next').click()
    const backup = join(folder, basename(input!, '.docx') + ' (before OCR).docx')
    await expect
      .poll(async () => (await readFile(backup).catch(() => null))?.equals(original), {
        timeout: 30_000,
      })
      .toBe(true)
    await expect
      .poll(
        async () => {
          const stored = await JSZip.loadAsync(await readFile(input!))
          return (await stored.file('word/document.xml')!.async('string')).includes('98765')
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.aiOfficeTabs.list()).find((tab) => tab.active)?.filePath,
        ),
      )
      .toBe(input)
    await expectEditorOcrTable(input!, true)
  } finally {
    await closeAndSaveVideo(launched, 'editor-ocr')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

for (const keep of [true, false]) {
  test(
    'editor OCR asks for a location before recognition with formatting ' + (keep ? 'on' : 'off'),
    async () => {
      const folder = test.info().outputPath('toolbar-destination')
      await mkdir(folder, { recursive: true })
      const launched = await launchShell({
        onboardingSeen: true,
        hideUpdateWindows: true,
        recordVideo: false,
        videoDir: 'ocr-destination',
        lang: 'en',
      })
      try {
        const { app, page } = launched
        const [input] = await writeOfficeTableFixtures(page, folder)
        await page.evaluate((path) => window.aiOffice.openPath(path), input!)
        await app.evaluate(({ dialog }, keepFormatting) => {
          const asked: string[] = []
          Object.assign(globalThis, { editorOcrQuestions: asked })
          dialog.showMessageBox = async function (...args) {
            const opts = args.at(-1) as Electron.MessageBoxOptions
            asked.push(opts.message)
            const response = asked.length === 1 && !keepFormatting ? 1 : (opts.defaultId ?? 0)
            return { response, checkboxChecked: false }
          }
        }, keep)
        await page.getByTestId('document-ocr').click()
        const location = await editorLocation(app)
        expect(await app.evaluate(() => Reflect.get(globalThis, 'editorOcrQuestions'))).toEqual([
          'Keep table and paragraph formatting?',
        ])
        await expect(location.locator('[data-kind="docx-before-images"]')).toBeVisible()
        await expect(location.locator('[data-kind="docx-next-page"]')).toBeVisible()
        await expect(location.locator('#location')).toBeEditable()
        if (keep) await location.locator('#location').fill('Table 1 row 1 column 1')
        else await location.locator('[data-kind="docx-next-page"]').click()
        await location.locator('#next').click()
        await expect
          .poll(() =>
            app
              .context()
              .pages()
              .some((p) => p.url().includes('mode=ocr-popup')),
          )
          .toBe(true)
        const popup = app
          .context()
          .pages()
          .find((p) => p.url().includes('mode=ocr-popup'))!
        const pick = popup.getByRole('button', { name: 'Choose items', exact: true })
        await expect(popup.locator('[data-action="select-all"]').or(pick).first()).toBeVisible()
        if (await pick.isVisible()) await pick.click()
        await popup.locator('[data-action="select-all"]').click()
        await popup.locator('[data-action="next"]').click()
        await expect(popup.locator('[data-confirm]')).toBeVisible()
        await expect(popup.getByTestId('ocr-picture-placement')).toHaveCount(0)
        expect(await readdir(folder)).not.toContain('word (OCR).docx')
      } finally {
        await closeAndSaveVideo(launched, 'ocr-destination')
        await rm(launched.userDataDir, { recursive: true, force: true })
      }
    },
  )
}

test('Word chat OCR separates formatting, destination and final confirmation', async () => {
  const folder = test.info().outputPath('chat-ocr')
  await mkdir(folder, { recursive: true })
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'chat-ocr',
    lang: 'ko',
  })
  try {
    const { app, page } = launched
    const [input] = await writeOfficeTableFixtures(page, folder)
    await page.evaluate((path) => window.aiOffice.openPath(path), input!)
    const editor = await waitForPageWithUrl(app, '://docs/')
    await editor.evaluate(async () => {
      const ocr = window.projectFolderApi.ocr!
      const turnId = 'ocr-picker-regression'
      const inspected = await ocr({ action: 'inspect', turnId })
      if (inspected.isError) throw Error(inspected.output)
      const { session } = JSON.parse(inspected.output)
      void ocr({ action: 'choose', session, turnId })
    })
    const popup = await waitForPageWithUrl(app, 'mode=ocr-popup')
    await expect(popup.locator('[data-step="format"]')).toBeVisible()
    await expect(popup.locator('select, [data-action="start"]')).toHaveCount(0)
    await test.info().attach('ocr-format', {
      body: await popup.locator('[data-step="format"]').screenshot(),
      contentType: 'image/png',
    })
    await popup.locator('[data-action="keep-format"]').click()
    await popup.getByRole('button', { name: '전체 처리', exact: true }).click()
    const location = popup.locator('[data-step="placement"]')
    await expect(location).toBeVisible()
    await expect(location.locator('select')).toHaveCount(0)
    await expect(location.getByRole('button', { name: '그림 앞', exact: true })).toBeVisible()
    await test
      .info()
      .attach('ocr-position', { body: await location.screenshot(), contentType: 'image/png' })
    await location.getByTestId('ocr-destination-input').fill('다음 페이지')
    await expect(location.locator('[data-action="start"]')).toHaveCount(0)
    await location.locator('[data-action="confirm-placement"]').click()
    await expect(popup.locator('[data-confirm]')).toBeVisible()
    await expect(popup.getByTestId('ocr-destination-input')).toHaveCount(0)
  } finally {
    await closeAndSaveVideo(launched, 'chat-ocr')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
