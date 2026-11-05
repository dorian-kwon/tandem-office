import { describe, expect, it, vi } from 'vitest'
import { createFeedAuth, ghCandidates } from '../src/main/update-auth'

const TOKEN = 'gho_' + 'a'.repeat(36)

describe('update feed auth (gh login)', () => {
  it('finds gh on PATH and in the usual GUI-less places', () => {
    const list = ghCandidates({ PATH: '/a:/b' }, 'darwin')
    expect(list).toContain('/a/gh')
    expect(list).toContain('/opt/homebrew/bin/gh')
    expect(ghCandidates({ ProgramFiles: 'C:\\P' }, 'win32').some((p) => p.endsWith('gh.exe'))).toBe(
      true,
    )
  })
  it('returns the token, runs gh without a shell argument list and caches it', async () => {
    const run = vi.fn().mockResolvedValue(`${TOKEN}\n`)
    const auth = createFeedAuth({ env: { PATH: '/a', FOO: 'x' }, exists: () => true, run })
    expect(await auth.token()).toBe(TOKEN)
    expect(await auth.token()).toBe(TOKEN)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[1]).toEqual(['auth', 'token', '--hostname', 'github.com'])
    expect(run.mock.calls[0]?.[2]).not.toHaveProperty('FOO')
  })
  it('is null without gh or a login, and retries only after a minute', async () => {
    let t = 0
    const none = createFeedAuth({ env: {}, exists: () => false, now: () => t })
    expect(await none.token()).toBeNull()
    const run = vi.fn().mockRejectedValueOnce(new Error('not logged in')).mockResolvedValue(TOKEN)
    const auth = createFeedAuth({ env: {}, exists: () => true, run, now: () => t })
    expect(await auth.token()).toBeNull()
    t = 30_000
    expect(await auth.token()).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
    t = 61_000
    expect(await auth.token()).toBe(TOKEN)
  })
  it('rejects output that is not a token', async () => {
    const auth = createFeedAuth({ env: {}, exists: () => true, run: async () => 'no oauth token found' })
    expect(await auth.token()).toBeNull()
  })
})
