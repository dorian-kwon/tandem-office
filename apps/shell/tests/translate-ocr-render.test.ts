import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf, loadPdfium } from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { runStructureJob, type JobDeps } from '../src/main/pdf-structure/jobs'
import type { PageCountJobValue, PageImageJobValue } from '../src/main/pdf-structure/protocol'

/**
 * The two structure-job ops the translation OCR uses (real PDFium): the page
 * count of a PDF and one page as a PNG.
 */

let dir: string
let pdfPath: string
let bytes: Uint8Array
const deps: JobDeps = { pdfium: loadPdfium, ocr: () => null }
const noProgress = () => {}

beforeAll(async () => {
  bytes = await buildPdf([
    [{ kind: 'text', text: 'One', x: 72, y: 700 }],
    [{ kind: 'text', text: 'Two', x: 72, y: 700 }],
    [{ kind: 'text', text: 'Three', x: 72, y: 700 }],
  ])
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'translate-ocr-render-'))
  pdfPath = join(dir, 'scan.pdf')
  writeFileSync(pdfPath, bytes)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('OCR page jobs', () => {
  it('pageCount answers the number of pages', async () => {
    const value = (await runStructureJob(
      { op: 'pageCount', source: { pdfPath } },
      deps,
      noProgress,
    )) as PageCountJobValue
    expect(value.pageCount).toBe(3)
  })

  it('pageImage renders one page as a PNG', async () => {
    const value = (await runStructureJob(
      { op: 'pageImage', source: { pdfPath }, page: 2 },
      deps,
      noProgress,
    )) as PageImageJobValue
    expect(value.page).toBe(2)
    // the PNG signature
    expect([...value.png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  it('pageImage refuses a page outside the document', async () => {
    await expect(
      runStructureJob({ op: 'pageImage', source: { pdfPath }, page: 4 }, deps, noProgress),
    ).rejects.toThrow()
  })
})
