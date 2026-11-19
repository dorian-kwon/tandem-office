import { describe, expect, it } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import {
  IDLE_RUN_STATUS,
  formatRunElapsed,
  reduceRunStatus,
  runStatusLabel,
  type RunStatusAction,
  type RunStatusState,
} from '../src/ai-run-status'
import { AI_RUN_STATUS_STRINGS } from '../src/strings-ai-run-status'

const run = (...actions: RunStatusAction[]): RunStatusState =>
  actions.reduce(reduceRunStatus, IDLE_RUN_STATUS)

describe('run status state machine', () => {
  it('goes running -> waiting -> running -> done', () => {
    let s = run({ type: 'begin', at: 100 })
    expect(s.phase).toBe('running')
    s = reduceRunStatus(s, { type: 'tool-start', name: 'ocr_pictures' })
    expect(s.tool).toBe('ocr_pictures')
    s = reduceRunStatus(s, { type: 'tool-done', awaitingUser: true, at: 200 })
    expect(s.phase).toBe('waiting')
    expect(s.since).toBe(200)
    // the next tool of the same run means the person answered
    s = reduceRunStatus(s, { type: 'tool-start', name: 'read_runs' })
    expect(s.phase).toBe('running')
    expect(s.awaiting).toBe(false)
    s = reduceRunStatus(s, { type: 'tool-done', note: 'Nothing is left' })
    s = reduceRunStatus(s, { type: 'done', cancelled: false })
    expect(s.phase).toBe('done')
    expect(s.note).toBe('Nothing is left')
  })

  it('reuses the writing state across text chunks and resumes writing after a tool', () => {
    const writing = run({ type: 'begin', at: 1 }, { type: 'text' })
    expect(reduceRunStatus(writing, { type: 'text' })).toBe(writing)
    const tool = reduceRunStatus(writing, { type: 'tool-start', name: 'read_runs' })
    expect(tool).toMatchObject({ writing: false, tool: 'read_runs' })
    const endedTool = reduceRunStatus(tool, { type: 'tool-done' })
    expect(reduceRunStatus(endedTool, { type: 'text' })).toEqual(writing)
  })

  it('stays waiting after the run ends until the person answers', () => {
    let s = run(
      { type: 'begin', at: 1 },
      { type: 'tool-start', name: 'x' },
      { type: 'tool-done', awaitingUser: true, at: 5 },
      { type: 'text' },
      { type: 'done', cancelled: false },
    )
    expect(s.phase).toBe('waiting')
    s = reduceRunStatus(s, { type: 'resolve-waiting' })
    expect(s.phase).toBe('idle')
  })

  it('resolving the wait mid-run goes back to running', () => {
    const s = run(
      { type: 'begin', at: 1 },
      { type: 'tool-done', awaitingUser: true, at: 5 },
      { type: 'resolve-waiting' },
    )
    expect(s.phase).toBe('running')
  })

  it('a new run clears a finished wait, but a duplicate begin mid-run keeps the clock', () => {
    let s = run({ type: 'begin', at: 1 }, { type: 'tool-done', awaitingUser: true, at: 2 })
    s = reduceRunStatus(s, { type: 'done', cancelled: false })
    s = reduceRunStatus(s, { type: 'begin', at: 50 })
    expect(s).toMatchObject({ phase: 'running', startedAt: 50, awaiting: false })
    s = reduceRunStatus(s, { type: 'begin', at: 99 })
    expect(s.startedAt).toBe(50)
  })

  it('user stop ends as stopped, errors as error, even while waiting', () => {
    expect(run({ type: 'begin', at: 1 }, { type: 'done', cancelled: true }).phase).toBe('stopped')
    expect(run({ type: 'begin', at: 1 }, { type: 'error' }).phase).toBe('error')
    expect(
      run(
        { type: 'begin', at: 1 },
        { type: 'tool-done', awaitingUser: true, at: 2 },
        { type: 'done', cancelled: true },
      ).phase,
    ).toBe('stopped')
  })

  it('queue: the next queued run starts fresh after done', () => {
    const s = run(
      { type: 'begin', at: 1 },
      { type: 'tool-done', note: 'old' },
      { type: 'done', cancelled: false },
      { type: 'begin', at: 9 },
    )
    expect(s).toMatchObject({ phase: 'running', startedAt: 9 })
    expect(s.note).toBeUndefined()
  })

  it('a busy flag dropping without a terminal event falls back to idle; dismiss clears done', () => {
    expect(run({ type: 'begin', at: 1 }, { type: 'idle' }).phase).toBe('idle')
    expect(
      run({ type: 'begin', at: 1 }, { type: 'done', cancelled: false }, { type: 'dismiss' }).phase,
    ).toBe('idle')
    // dismiss never hides a wait or a running state
    expect(run({ type: 'begin', at: 1 }, { type: 'dismiss' }).phase).toBe('running')
  })

  it('events outside a run are ignored', () => {
    expect(run({ type: 'tool-start', name: 'a' }, { type: 'text' }).phase).toBe('idle')
  })
})

describe('labels and strings', () => {
  it('names the tool while one runs and the note when done', () => {
    const running = run({ type: 'begin', at: 0 }, { type: 'tool-start', name: 'translate_blocks' })
    expect(runStatusLabel(running, 'en')).toBe('Running a tool: translate blocks')
    expect(runStatusLabel(run({ type: 'begin', at: 0 }), 'en')).toBe('Working')
    const done = run(
      { type: 'begin', at: 0 },
      { type: 'tool-done', note: 'Nothing is left' },
      { type: 'done', cancelled: false },
    )
    expect(runStatusLabel(done, 'en')).toBe('Finished · Nothing is left')
  })

  it('formats elapsed time', () => {
    expect(formatRunElapsed(0)).toBe('0:00')
    expect(formatRunElapsed(65_400)).toBe('1:05')
    expect(formatRunElapsed(3_725_000)).toBe('1:02:05')
  })

  it('fills every language without leaving English in non-Latin ones', () => {
    const latin = new Set(['en', 'fr', 'de', 'es', 'id', 'pt', 'it', 'pl', 'cs', 'nl', 'ms', 'vi'])
    for (const lang of LANGS) {
      const s = AI_RUN_STATUS_STRINGS[lang]
      expect(s.tool, lang).toContain('{tool}')
      for (const v of Object.values(s)) expect(v.trim().length, lang).toBeGreaterThan(0)
      if (!latin.has(lang)) {
        expect(s.working, lang).not.toBe(AI_RUN_STATUS_STRINGS.en.working)
        expect(s.waiting, lang).not.toBe(AI_RUN_STATUS_STRINGS.en.waiting)
      }
    }
  })
})
