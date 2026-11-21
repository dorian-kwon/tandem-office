/**
 * Performance, memory baseline, and OS child-process lifecycle risk suite.
 * Proves:
 * - Streaming 105 MiB+ media-heavy ZIP extraction succeeds quickly with bounded memory
 * - 1,000,000-char body CJK+Latin tokenization executes rapidly in Rust
 * - shutdown(), stop(), and parent exit (stdin EOF) leave ZERO orphan OS processes
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseFileToText,
  ParseSidecarClient,
  resolveParseSidecarPath,
  stopParseSidecar,
} from '../src/index'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

let workDir: string
let sidecarBin: string
const savedSidecarEnv = process.env.GENOFFICE_PARSE_SIDECAR

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPidExit(pid: number, timeoutMs = 4_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return !isPidAlive(pid)
}

async function buildMediaDocx(mediaMiB: number, marker: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>${marker}</w:t></w:r></w:p></w:body></w:document>`,
  )
  zip.file('word/media/video.bin', Buffer.alloc(mediaMiB * 1024 * 1024), { compression: 'STORE' })
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

beforeAll(() => {
  const bin = resolveParseSidecarPath()
  expect(bin, 'compiled ieum-parse-sidecar binary must exist').toBeTruthy()
  sidecarBin = bin!
  workDir = mkdtempSync(join(tmpdir(), 'ieum-risk-perf-'))
})

afterAll(() => {
  stopParseSidecar()
  if (savedSidecarEnv === undefined) delete process.env.GENOFFICE_PARSE_SIDECAR
  else process.env.GENOFFICE_PARSE_SIDECAR = savedSidecarEnv
  rmSync(workDir, { recursive: true, force: true })
})

describe('Track A performance, memory baseline, and process lifecycle', () => {
  it.runIf(process.env.GENOFFICE_LOAD_TESTS === '1')(
    'benchmarks 20 MiB media DOCX (Rust vs TS) and extracts 105 MiB media DOCX with bounded memory',
    async () => {
      const mediumPath = join(workDir, 'media-20m.docx')
      writeFileSync(mediumPath, await buildMediaDocx(20, 'MediumMediaMarker20M'))

      // Warm up interactive sidecar
      process.env.GENOFFICE_PARSE_SIDECAR = '1'
      await parseFileToText(mediumPath)

      const t0Rust = performance.now()
      const rust20 = await parseFileToText(mediumPath)
      const rust20Ms = performance.now() - t0Rust
      expect(rust20.ok).toBe(true)
      expect(rust20.text).toContain('MediumMediaMarker20M')

      process.env.GENOFFICE_PARSE_SIDECAR = '0'
      const heapBeforeTs = process.memoryUsage().heapUsed
      const t0Ts = performance.now()
      const ts20 = await parseFileToText(mediumPath)
      const ts20Ms = performance.now() - t0Ts
      const tsHeapDeltaMb = (process.memoryUsage().heapUsed - heapBeforeTs) / (1024 * 1024)
      expect(ts20.ok).toBe(true)
      expect(ts20.text).toBe(rust20.text)

      // 105 MiB media-heavy DOCX: streaming extraction via Rust sidecar must succeed cleanly
      const hugePath = join(workDir, 'media-105m.docx')
      writeFileSync(hugePath, await buildMediaDocx(105, 'HugeMediaMarker105M'))
      process.env.GENOFFICE_PARSE_SIDECAR = '1'
      const rssBeforeHuge = process.memoryUsage().rss
      const t0Huge = performance.now()
      const rust105 = await parseFileToText(hugePath)
      const rust105Ms = performance.now() - t0Huge
      const rssDeltaHugeMb = (process.memoryUsage().rss - rssBeforeHuge) / (1024 * 1024)

      expect(rust105.ok).toBe(true)
      expect(rust105.text).toContain('HugeMediaMarker105M')
      // Must stay far below 8 GB PC safety threshold and finish rapidly
      expect(rssDeltaHugeMb).toBeLessThan(256)
      expect(rust105Ms).toBeLessThan(15_000)

      console.info(
        `[perf-baseline:zip] 20MiB DOCX rust=${rust20Ms.toFixed(1)}ms ts=${ts20Ms.toFixed(1)}ms ` +
          `tsHeapDelta=${tsHeapDeltaMb.toFixed(1)}MiB | 105MiB DOCX rust=${rust105Ms.toFixed(1)}ms ` +
          `parentRssDelta=${rssDeltaHugeMb.toFixed(1)}MiB`,
      )
    },
    45_000,
  )

  it.runIf(process.env.GENOFFICE_LOAD_TESTS === '1')(
    'benchmarks 1,000,000-character CJK+Latin body tokenization in Rust sidecar',
    async () => {
      const unit = '인공지능 보고서 2026 Project Alpha 東京 테스트 데이터 분석 요약 '
      const millionText = unit.repeat(Math.ceil(1_000_000 / unit.length)).slice(0, 1_000_000)
      const client = new ParseSidecarClient()
      try {
        const t0 = performance.now()
        const tokens = await client.tokenizeText(millionText)
        const rustMs = performance.now() - t0
        expect(tokens.bi.length).toBeGreaterThan(500_000)
        expect(tokens.uni.length).toBeGreaterThan(500_000)
        expect(rustMs).toBeLessThan(10_000)
        console.info(
          `[perf-baseline:tokenize-1M] rust=${rustMs.toFixed(1)}ms biChars=${tokens.bi.length} uniChars=${tokens.uni.length}`,
        )
      } finally {
        await client.shutdown()
      }
    },
    30_000,
  )

  it('leaves zero orphan OS processes after shutdown(), stop(), and abrupt parent exit (stdin EOF)', async () => {
    // 1. shutdown()
    const c1 = new ParseSidecarClient()
    await c1.tokenizeText('hello')
    const pid1 = c1.pid()
    expect(pid1).toBeTypeOf('number')
    expect(isPidAlive(pid1!)).toBe(true)
    await c1.shutdown()
    expect(await waitForPidExit(pid1!)).toBe(true)

    // 2. stop()
    const c2 = new ParseSidecarClient()
    await c2.tokenizeText('world')
    const pid2 = c2.pid()
    expect(pid2).toBeTypeOf('number')
    expect(isPidAlive(pid2!)).toBe(true)
    c2.stop()
    expect(await waitForPidExit(pid2!)).toBe(true)

    // 3. Abrupt parent exit -> stdin EOF must terminate child immediately
    const parentScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.argv[1], ['--indexer'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      process.stdout.write(String(child.pid) + '\\n');
      setTimeout(() => process.exit(0), 50);
    `
    const childPid = await new Promise<number>((resolve, reject) => {
      const parent = spawn(process.execPath, ['-e', parentScript, sidecarBin], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      parent.stdout.on('data', (d) => {
        out += String(d)
      })
      parent.on('error', reject)
      parent.on('exit', () => {
        const parsed = Number.parseInt(out.trim(), 10)
        if (!Number.isFinite(parsed)) reject(new Error(`invalid child pid: ${out}`))
        else resolve(parsed)
      })
    })
    expect(await waitForPidExit(childPid, 4_000)).toBe(true)
  }, 20_000)
})
