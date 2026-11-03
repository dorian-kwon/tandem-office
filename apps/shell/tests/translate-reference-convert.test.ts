import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { convertReference } from '../src/main/translate/reference-convert'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'translate-refconv-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** a one-page PDF with the given content stream, with a correct xref table */
function pdfWith(content: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body))
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = Buffer.byteLength(body)
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) body += `${String(o).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

describe('convertReference (file-parse reader)', () => {
  it('an image-only PDF needs OCR', async () => {
    // a page that only paints a rectangle: no text layer at all
    const path = join(root, 'scan.pdf')
    writeFileSync(path, pdfWith('0 0 0 rg 72 72 468 648 re f'))
    expect(await convertReference(path)).toEqual({ ok: false, reason: 'needs-ocr' })
  })

  it('a text PDF converts to its text', async () => {
    const path = join(root, 'text.pdf')
    writeFileSync(path, pdfWith('BT /F1 12 Tf 72 720 Td (Liability clause of the contract) Tj ET'))
    const out = await convertReference(path)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.md).toContain('Liability clause of the contract')
  })

  it('a markdown file converts as is', async () => {
    const path = join(root, 'notes.md')
    writeFileSync(path, '# Terms\n\nengine means 엔진')
    expect(await convertReference(path)).toEqual({ ok: true, md: '# Terms\n\nengine means 엔진' })
  })

  it('a broken document is a failure, not an exception', async () => {
    const path = join(root, 'broken.docx')
    writeFileSync(path, 'not a zip')
    expect(await convertReference(path)).toEqual({ ok: false, reason: 'failed' })
  })

  it('a picture needs OCR', async () => {
    const path = join(root, 'page.png')
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(await convertReference(path)).toEqual({ ok: false, reason: 'needs-ocr' })
  })
})
