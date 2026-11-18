import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SPARE_RECHECK_MS,
  readMemory,
  spareViewVerdict,
  type MemoryReading,
} from '../src/main/spare-view-policy'

/**
 * The spare Sheets view costs about 200 MB, so it is kept only while the PC has memory to
 * spare. The PC's free memory is read each time: a spare is made when there is plenty, let
 * go of when memory runs short, and the two limits are apart so it does not flap.
 */

const at = (totalMB: number, freeMB: number): MemoryReading => ({ totalMB, freeMB })

describe('spareViewVerdict: no spare yet', () => {
  it('makes one when free memory is at least 3 GB and a fifth of the PC', () => {
    expect(spareViewVerdict(at(16_384, 4_000), false)).toBe('create')
    expect(spareViewVerdict(at(16_384, 3_277), false)).toBe('create')
  })

  it('waits when it is less', () => {
    expect(spareViewVerdict(at(16_384, 3_000), false)).toBe('wait')
    expect(spareViewVerdict(at(16_384, 500), false)).toBe('wait')
  })

  it('asks for 3 GB on a small PC and a fifth of the memory on a big one', () => {
    expect(spareViewVerdict(at(8_192, 3_072), false)).toBe('create')
    expect(spareViewVerdict(at(8_192, 3_000), false)).toBe('wait')
    expect(spareViewVerdict(at(32_768, 6_000), false)).toBe('wait')
    expect(spareViewVerdict(at(32_768, 7_000), false)).toBe('create')
  })
})

describe('spareViewVerdict: a spare exists', () => {
  it('keeps it while memory is comfortable', () => {
    expect(spareViewVerdict(at(16_384, 8_000), true)).toBe('keep')
    expect(spareViewVerdict(at(16_384, 1_700), true)).toBe('keep')
  })

  it('lets it go when free memory falls under 1.5 GB or a tenth of the PC', () => {
    expect(spareViewVerdict(at(16_384, 1_500), true)).toBe('drop')
    expect(spareViewVerdict(at(8_192, 1_500), true)).toBe('drop')
    expect(spareViewVerdict(at(8_192, 1_600), true)).toBe('keep')
    expect(spareViewVerdict(at(65_536, 6_000), true)).toBe('drop')
  })
})

describe('the two limits', () => {
  it('leave a band where an existing spare stays and a missing one is not made', () => {
    expect(spareViewVerdict(at(16_384, 2_000), true)).toBe('keep')
    expect(spareViewVerdict(at(16_384, 2_000), false)).toBe('wait')
  })

  it('never let a spare be made and dropped at the same reading', () => {
    for (const totalMB of [4_096, 8_192, 16_384, 32_768, 65_536]) {
      for (let freeMB = 0; freeMB <= totalMB; freeMB += 128) {
        const makes = spareViewVerdict(at(totalMB, freeMB), false) === 'create'
        const drops = spareViewVerdict(at(totalMB, freeMB), true) === 'drop'
        expect(makes && drops, `${totalMB}/${freeMB}`).toBe(false)
      }
    }
  })

  it('look again every half minute', () => {
    expect(SPARE_RECHECK_MS).toBe(30_000)
  })
})

describe('readMemory', () => {
  const proc = process as unknown as { getSystemMemoryInfo?: () => unknown }
  const original = proc.getSystemMemoryInfo

  afterEach(() => {
    if (original) proc.getSystemMemoryInfo = original
    else delete proc.getSystemMemoryInfo
    vi.restoreAllMocks()
  })

  it('takes the memory the system says is available, in whole megabytes', () => {
    // Electron reports kilobytes; macOS counts reclaimable cache as available here, which
    // Node's os.freemem() does not
    proc.getSystemMemoryInfo = () => ({ total: 16 * 1024 * 1024, free: 5 * 1024 * 1024 })
    expect(readMemory()).toEqual({ totalMB: 16_384, freeMB: 5_120 })
  })

  it('falls back to Node when that is not there (a plain Node run)', () => {
    delete proc.getSystemMemoryInfo
    const memory = readMemory()
    expect(memory.totalMB).toBeGreaterThan(0)
    expect(memory.freeMB).toBeGreaterThanOrEqual(0)
    expect(memory.freeMB).toBeLessThanOrEqual(memory.totalMB)
  })

  it('falls back to Node when the answer is empty or broken', () => {
    proc.getSystemMemoryInfo = () => ({ total: 0, free: 0 })
    expect(readMemory().totalMB).toBeGreaterThan(0)
    proc.getSystemMemoryInfo = () => {
      throw new Error('not supported')
    }
    expect(readMemory().totalMB).toBeGreaterThan(0)
  })
})
