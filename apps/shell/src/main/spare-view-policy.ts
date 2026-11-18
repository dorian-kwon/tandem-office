import { freemem, totalmem } from 'node:os'

/**
 * When to keep a spare Sheets view. The shell mounts one Sheets renderer ahead of the next
 * open so a workbook opens faster, and it costs about 200 MB. It is worth that only while the
 * PC has memory to spare, so the PC's free memory is read each time and decides: make the
 * spare when there is plenty, let it go when memory runs short. The limit for making one is
 * higher than the limit for dropping it, so a PC hovering near either does not make and
 * close a view over and over.
 */

export interface MemoryReading {
  /** memory the system can hand out right now, MB */
  freeMB: number
  /** the PC's physical memory, MB */
  totalMB: number
}

export type SpareVerdict = 'create' | 'wait' | 'keep' | 'drop'

/** how often a missing spare is looked for again and an existing one is checked */
export const SPARE_RECHECK_MS = 30_000

const CREATE_MIN_FREE_MB = 3072
const CREATE_MIN_FREE_SHARE = 0.2
const DROP_MIN_FREE_MB = 1536
const DROP_MIN_FREE_SHARE = 0.1

const MB = 1024 * 1024

/**
 * The PC's free memory in whole megabytes. Electron's own reading is used when there is one:
 * it counts memory the system can reclaim (cache) as available, where Node's `os.freemem()`
 * on macOS counts only never-used pages and reads far too low. Plain Node (tests) and a failed
 * reading fall back to `os`.
 */
export function readMemory(): MemoryReading {
  try {
    const info = (
      process as unknown as { getSystemMemoryInfo?: () => { total: number; free: number } }
    ).getSystemMemoryInfo?.()
    if (info && info.total > 0) {
      return { totalMB: Math.round(info.total / 1024), freeMB: Math.round(info.free / 1024) }
    }
  } catch {
    /* fall through to os */
  }
  return { totalMB: Math.round(totalmem() / MB), freeMB: Math.round(freemem() / MB) }
}

/** what to do about the spare view at this reading of memory */
export function spareViewVerdict(memory: MemoryReading, spareExists: boolean): SpareVerdict {
  if (spareExists) {
    const dropBelow = Math.max(DROP_MIN_FREE_MB, memory.totalMB * DROP_MIN_FREE_SHARE)
    return memory.freeMB < dropBelow ? 'drop' : 'keep'
  }
  const createFrom = Math.max(CREATE_MIN_FREE_MB, memory.totalMB * CREATE_MIN_FREE_SHARE)
  return memory.freeMB >= createFrom ? 'create' : 'wait'
}
