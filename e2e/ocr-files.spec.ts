import { test, expect } from '@playwright/test'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { closeAndSaveVideo, launchShell } from './helpers'

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
    // Chromium-backed Files from a real file input carry native paths in Electron.
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.dataset.testid = 'native-drop-source'
      document.body.append(input)
    })
    const dropped = page.getByTestId('native-drop-source')
    await dropped.setInputFiles(inputs[1]!)
    await dropped.evaluate((el: HTMLInputElement) => {
      const transfer = new DataTransfer()
      transfer.items.add(el.files![0]!)
      document
        .querySelector('[data-testid="ocr-files-panel"]')!
        .dispatchEvent(
          new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        )
      el.remove()
    })
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
