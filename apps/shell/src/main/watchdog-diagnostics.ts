import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 2 * 1024 * 1024
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  const source = object(value)
  return Object.fromEntries(
    keys.flatMap((key) => {
      const number = source[key]
      return typeof number === 'number' && Number.isFinite(number) && number >= 0
        ? [[key, number]]
        : []
    }),
  )
}
const memoryKeys = ['workingSetSize', 'peakWorkingSetSize', 'privateBytes']
function metric(value: unknown): Record<string, unknown> {
  const source = object(value)
  return {
    ...numbers(source, ['pid']),
    ...(['Browser', 'Tab', 'GPU', 'Utility', 'Zygote', 'Sandbox helper', 'Unknown'].includes(
      String(source.type),
    )
      ? { type: source.type }
      : {}),
    cpu: numbers(source.cpu, ['percentCPUUsage', 'cumulativeCPUUsage', 'idleWakeupsPerSecond']),
    memory: numbers(source.memory, memoryKeys),
  }
}

/** Allowlist numeric resource measurements; never copy title, paths, URLs or profile data. */
export function scrubWatchdogDiagnostic(text: string): string {
  try {
    if (text.length > MAX_BYTES) return '(unavailable)'
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed)) {
      return JSON.stringify(
        parsed
          .slice(0, 3)
          .map((entry) => JSON.parse(scrubWatchdogDiagnostic(JSON.stringify(entry)))),
        null,
        2,
      )
    }
    const source = object(parsed)
    const kind = object(source.document).kind ?? source.editor
    const result = {
      ...(typeof source.at === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(source.at)
        ? { at: source.at }
        : {}),
      ...numbers(source, ['webContentsId', 'pid', 'memoryMB', 'cpuPercent']),
      ...([
        'docs',
        'sheets',
        'slides',
        'pdf',
        'markdown',
        'html',
        'hwp',
        'mindmap',
        'epub',
      ].includes(String(kind))
        ? { editor: kind }
        : {}),
      systemMemory: numbers(source.systemMemory, ['totalMB', 'freeMB']),
      metric: metric(source.metric),
      appMetrics: Array.isArray(source.appMetrics)
        ? source.appMetrics.slice(0, 100).map(metric)
        : [],
    }
    return JSON.stringify(result, null, 2)
  } catch {
    return '(unavailable)'
  }
}

/** Reads the newest three valid bounded JSON diagnostics; profiles are never included. */
export function newestWatchdogDiagnostic(folder: string): string {
  try {
    const names = readdirSync(folder)
      .filter((name) => /^renderer-watchdog-\d{13}\.json$/.test(name))
      .sort()
      .reverse()
    const records: unknown[] = []
    // Limit work even if old installations collected many diagnostics.
    for (const name of names.slice(0, 20)) {
      try {
        const path = join(folder, name)
        if (statSync(path).size > MAX_BYTES) continue
        const clean = scrubWatchdogDiagnostic(readFileSync(path, 'utf8'))
        if (clean === '(unavailable)') continue
        records.push(JSON.parse(clean))
        if (records.length === 3) break
      } catch {
        /* try the next recent record */
      }
    }
    return records.length ? JSON.stringify(records, null, 2) : ''
  } catch {
    return ''
  }
}
