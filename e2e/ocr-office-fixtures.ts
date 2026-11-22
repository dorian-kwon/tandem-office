import type { Page } from '@playwright/test'
import { Document, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function writeOfficeTableFixtures(page: Page, folder: string): Promise<string[]> {
  // A ruled scan inside an editable, merged cell exercises both kinds of table.
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 220
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.lineWidth = 2
    ctx.font = '32px sans-serif'
    ctx.fillStyle = 'black'
    const cells = [
      ['Region', 'Count'],
      ['Busan', '98765'],
    ]
    cells.forEach((row, y) =>
      row.forEach((label, x) => {
        ctx.strokeRect(20 + x * 300, 20 + y * 88, 300, 88)
        ctx.fillText(label, 40 + x * 300, 75 + y * 88)
      }),
    )
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  const png = Buffer.from(base64, 'base64')
  const scan = new ImageRun({
    type: 'png',
    data: png,
    transformation: { width: 320, height: 110 },
  })
  const table = new Table({
    columnWidths: [3600, 3600],
    rows: [
      new TableRow({
        children: [
          new TableCell({
            columnSpan: 2,
            children: [new Paragraph('Native merged header'), new Paragraph({ children: [scan] })],
          }),
        ],
      }),
      new TableRow({
        children: ['West', 'East'].map(
          (region) => new TableCell({ children: [new Paragraph(region)] }),
        ),
      }),
    ],
  })
  const docx = join(folder, 'word.docx')
  await writeFile(docx, await Packer.toBuffer(new Document({ sections: [{ children: [table] }] })))

  const { default: init, HwpDocument } = await import('../vendor/rhwp-core/rhwp.js')
  await init({
    module_or_path: await readFile(join(__dirname, '../vendor/rhwp-core/rhwp_bg.wasm')),
  })
  const form = new HwpDocument(
    await readFile(join(__dirname, '../apps/shell/tests/fixtures/ocr-nested-tables.hwp')),
  )
  const hwp = join(folder, 'hangul.hwp'),
    hwpx = join(folder, 'hangul-xml.hwpx')
  try {
    const last = form.getParagraphCount(0) - 1
    form.splitParagraph(0, last, form.getParagraphLength(0, last))
    // Display at 320 × 110 px, the same half-scale scan as the Word fixture.
    const result = form.insertPicture(0, last + 1, 0, '', png, 24000, 8250, 640, 220, 'png', '')
    if (!JSON.parse(result).ok) throw new Error(result)
    await writeFile(hwp, form.exportHwp())
    await writeFile(hwpx, form.exportHwpx())
  } finally {
    form.free()
  }
  return [docx, hwp, hwpx]
}
