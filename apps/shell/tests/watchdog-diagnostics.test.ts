import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { newestWatchdogDiagnostic, scrubWatchdogDiagnostic } from '../src/main/watchdog-diagnostics'

it('keeps resource measurements and drops all titles, paths, URLs, private strings and profiles', () => {
  const diagnostic = JSON.stringify({
    at: '2026-11-18T10:00:00.000Z',
    memoryMB: 2000,
    cpuPercent: 95,
    document: { kind: 'docs', title: 'Secret contract', filePath: '/Users/person/secret.docx' },
    url: 'file:///private/install/index.html',
    systemMemory: { freeMB: 1000, totalMB: 8192 },
    metric: {
      pid: 123,
      type: 'Tab',
      name: 'private',
      memory: { privateBytes: 2048000 },
      cpu: { cumulativeCPUUsage: 50 },
    },
    appMetrics: [
      { pid: 123, type: 'Tab', serviceName: '/private/thing', memory: { workingSetSize: 10 } },
    ],
    profile: { secret: 'source text' },
  })
  const scrubbed = scrubWatchdogDiagnostic(diagnostic)
  expect(scrubbed).not.toMatch(
    /Secret|\/private|person|contract|source text|filePath|url|profile|serviceName|"name"/,
  )
  expect(JSON.parse(scrubbed)).toMatchObject({
    editor: 'docs',
    memoryMB: 2000,
    systemMemory: { freeMB: 1000, totalMB: 8192 },
  })
  expect(scrubWatchdogDiagnostic(scrubbed)).toBe(scrubbed)
})
it('reads the newest three valid JSON records, ignoring profiles and broken/oversized records', () => {
  const folder = mkdtempSync(join(tmpdir(), 'watchdog-report-'))
  try {
    expect(newestWatchdogDiagnostic(folder)).toBe('')
    writeFileSync(join(folder, 'renderer-watchdog-1000000000000.json'), '{"memoryMB": 1000}')
    writeFileSync(join(folder, 'renderer-watchdog-1000000000001.json'), '{"memoryMB": 2000}')
    writeFileSync(join(folder, 'renderer-watchdog-1000000000002.cpuprofile'), 'secret')
    expect(newestWatchdogDiagnostic(folder)).toContain('2000')
    writeFileSync(join(folder, 'renderer-watchdog-1000000000003.json'), 'broken')
    expect(newestWatchdogDiagnostic(folder)).toContain('2000')
    writeFileSync(
      join(folder, 'renderer-watchdog-1000000000004.json'),
      'x'.repeat(2 * 1024 * 1024 + 1),
    )
    writeFileSync(join(folder, 'renderer-watchdog-1000000000005.json'), '{"memoryMB": 3000}')
    writeFileSync(join(folder, 'renderer-watchdog-1000000000006.json'), '{"memoryMB": 4000}')
    const result = JSON.parse(newestWatchdogDiagnostic(folder))
    expect(result.map((entry: { memoryMB: number }) => entry.memoryMB)).toEqual([4000, 3000, 2000])
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
