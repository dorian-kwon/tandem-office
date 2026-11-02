import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildPdf, loadPdfium } from '../../../packages/pdf-structure/tests/helpers/fixtures'
import { runStructureJob, type JobDeps } from '../src/main/pdf-structure/jobs'
import {
  parseRunMessage,
  type StructureOp,
  type TextCountsJobValue,
} from '../src/main/pdf-structure/protocol'
import {
  SCAN_MIN_TEXT_CHARS,
  detectScan,
  isMostlyScanned,
} from '../src/main/translate/non-editable'

/**
 * Scan detection for the translation tool: the structure job that counts the
 * characters of each page's text layer (real PDFium), and the rule that turns
 * those counts into "this PDF is a scan".
 */

let dir: string
const deps: JobDeps = { pdfium: loadPdfium, ocr: () => null }
const noProgress = () => {}
let textPdf: Uint8Array
let imagePdf: Uint8Array

const SENTENCE = 'The quick brown fox jumps over the lazy dog near the river bank.'

beforeAll(async () => {
  textPdf = await buildPdf([
    [{ kind: 'text', text: SENTENCE, x: 72, y: 700 }],
    [{ kind: 'text', text: SENTENCE, x: 72, y: 700 }],
  ])
  // pages that hold only a picture: no text layer, as a scanner writes them
  imagePdf = await buildPdf([
    [{ kind: 'image', x: 72, y: 400, width: 300, height: 300 }],
    [{ kind: 'image', x: 72, y: 400, width: 300, height: 300 }],
    [{ kind: 'text', text: SENTENCE, x: 72, y: 700 }],
  ])
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'translate-scan-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function write(name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

describe('textCounts structure job', () => {
  it('counts the characters of every page of a text PDF', async () => {
    const pdfPath = write('text.pdf', textPdf)
    const value = (await runStructureJob(
      { op: 'textCounts', source: { pdfPath } },
      deps,
      noProgress,
    )) as TextCountsJobValue
    expect(value.counts).toHaveLength(2)
    for (const n of value.counts) expect(n).toBeGreaterThanOrEqual(SENTENCE.length - 5)
  })

  it('gives 0 for pages without a text layer', async () => {
    const pdfPath = write('scan.pdf', imagePdf)
    const value = (await runStructureJob(
      { op: 'textCounts', source: { pdfPath } },
      deps,
      noProgress,
    )) as TextCountsJobValue
    expect(value.counts.slice(0, 2)).toEqual([0, 0])
    expect(value.counts[2]).toBeGreaterThan(SCAN_MIN_TEXT_CHARS)
  })

  it('the child accepts the ops the translation tool sends', () => {
    const setup = { wasmPath: '/w.wasm', ocrHelperPaths: [] }
    const ops: StructureOp[] = ['pageCount', 'pageImage', 'textCounts']
    for (const op of ops) {
      expect(
        parseRunMessage({ type: 'run', setup, job: { op, source: { pdfPath: '/a.pdf' } } }),
      ).not.toBeNull()
    }
  })
})

describe('isMostlyScanned', () => {
  it('is true when at least half the pages have almost no text', () => {
    expect(isMostlyScanned([0, 0, 500])).toBe(true)
    expect(isMostlyScanned([0, 500])).toBe(true)
    expect(isMostlyScanned([SCAN_MIN_TEXT_CHARS - 1])).toBe(true)
  })

  it('is false when most pages have a text layer', () => {
    expect(isMostlyScanned([0, 500, 500])).toBe(false)
    expect(isMostlyScanned([SCAN_MIN_TEXT_CHARS, SCAN_MIN_TEXT_CHARS])).toBe(false)
  })

  it('is false for a document without pages', () => {
    expect(isMostlyScanned([])).toBe(false)
  })
})

describe('detectScan', () => {
  it('asks for the page counts of that file only', async () => {
    const asked: string[] = []
    const scan = await detectScan('/p/source/a.pdf', {
      pageTextCounts: async (path) => {
        asked.push(path)
        return [0, 0, 0]
      },
    })
    expect(scan).toBe(true)
    expect(asked).toEqual(['/p/source/a.pdf'])
  })

  it('a text PDF is not a scan', async () => {
    expect(await detectScan('/a.pdf', { pageTextCounts: async () => [900, 800] })).toBe(false)
  })

  it('works on the real job output', async () => {
    const pdfPath = write('scan.pdf', imagePdf)
    const pageTextCounts = async (path: string) =>
      (
        (await runStructureJob(
          { op: 'textCounts', source: { pdfPath: path } },
          deps,
          noProgress,
        )) as TextCountsJobValue
      ).counts
    expect(await detectScan(pdfPath, { pageTextCounts })).toBe(true)
    expect(await detectScan(write('text.pdf', textPdf), { pageTextCounts })).toBe(false)
  })
})
