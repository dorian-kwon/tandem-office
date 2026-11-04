/** @vitest-environment jsdom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LANGS } from '@genoffice/i18n'
import { IDLE_RUN_STATUS, reduceRunStatus, type RunStatusState } from '../src/ai-run-status'
import { TRANSLATION_LOCK_STRINGS } from '../src/strings-translation-lock'
import {
  TRANSLATION_LOCK_IDLE_MS,
  translationLockWanted,
  useTranslationLock,
  type TranslationLockController,
} from '../src/use-translation-lock'
import { TranslationLockBanner } from '../src/TranslationLockBanner'

const running = (): RunStatusState => reduceRunStatus(IDLE_RUN_STATUS, { type: 'begin', at: 1 })
const waiting = (): RunStatusState =>
  reduceRunStatus(
    reduceRunStatus(running(), { type: 'tool-start', name: 'ocr_pictures' }),
    { type: 'tool-done', awaitingUser: true, at: 2 },
  )

describe('translationLockWanted: run phase to editable mapping', () => {
  it('locks only while running inside the translation output', () => {
    expect(translationLockWanted(true, running())).toBe(true)
    expect(translationLockWanted(false, running())).toBe(false)
  })
  it('stays unlocked while waiting for the person, and after every end', () => {
    expect(translationLockWanted(true, waiting())).toBe(false)
    expect(translationLockWanted(true, IDLE_RUN_STATUS)).toBe(false)
    const ended = (a: Parameters<typeof reduceRunStatus>[1]) => reduceRunStatus(running(), a)
    expect(translationLockWanted(true, ended({ type: 'done', cancelled: false }))).toBe(false)
    expect(translationLockWanted(true, ended({ type: 'done', cancelled: true }))).toBe(false)
    expect(translationLockWanted(true, ended({ type: 'error' }))).toBe(false)
  })
})

describe('strings', () => {
  it('has the banner and button text in every UI language', () => {
    for (const lang of LANGS) {
      const t = TRANSLATION_LOCK_STRINGS[lang]
      expect(t.banner.length, lang).toBeGreaterThan(5)
      expect(t.unlock.length, lang).toBeGreaterThan(0)
    }
    expect(Object.keys(TRANSLATION_LOCK_STRINGS)).toHaveLength(LANGS.length)
    expect(TRANSLATION_LOCK_STRINGS.en.banner).toBe(
      'The AI is translating; editing is locked until it finishes',
    )
  })
})

describe('useTranslationLock and the banner', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let ctl: TranslationLockController
  const onStop = vi.fn()
  const probe = vi.fn(async () => true)
  const Probe = ({ state, isOutput }: { state: RunStatusState; isOutput?: boolean }) => {
    ctl = useTranslationLock({
      state,
      probe: isOutput === false ? async () => false : probe,
      onStop,
    })
    return ctl.locked
      ? createElement(TranslationLockBanner, { lang: 'en', onUnlock: ctl.unlock })
      : null
  }
  const flush = async () => {
    await act(async () => {
      await Promise.resolve()
    })
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    onStop.mockClear()
    probe.mockClear()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('locks when the run starts in a translation output and unlocks when it ends', async () => {
    act(() => root.render(createElement(Probe, { state: IDLE_RUN_STATUS })))
    expect(ctl.locked).toBe(false)
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    expect(ctl.locked).toBe(true)
    expect(host.textContent).toContain('editing is locked')
    act(() =>
      root.render(createElement(Probe, { state: reduceRunStatus(running(), { type: 'error' }) })),
    )
    expect(ctl.locked).toBe(false)
    expect(host.textContent).toBe('')
  })

  it('never locks an ordinary document', async () => {
    act(() => root.render(createElement(Probe, { state: running(), isOutput: false })))
    await flush()
    expect(ctl.locked).toBe(false)
  })

  it('unlocks while the AI waits for the person and locks again when it resumes', async () => {
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    expect(ctl.locked).toBe(true)
    act(() => root.render(createElement(Probe, { state: waiting() })))
    expect(ctl.locked).toBe(false)
    act(() =>
      root.render(
        createElement(Probe, { state: reduceRunStatus(waiting(), { type: 'tool-start', name: 'x' }) }),
      ),
    )
    expect(ctl.locked).toBe(true)
  })

  it('the Unlock button unlocks and stops the run', async () => {
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    const button = host.querySelector('button')
    expect(button?.textContent).toBe('Unlock')
    act(() => button?.click())
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(ctl.locked).toBe(false)
    // the override ends with the run, so the next run locks again
    act(() => root.render(createElement(Probe, { state: IDLE_RUN_STATUS })))
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    expect(ctl.locked).toBe(true)
  })

  it('the watchdog releases a lock whose run reported nothing for too long', async () => {
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    expect(ctl.locked).toBe(true)
    act(() => {
      vi.advanceTimersByTime(TRANSLATION_LOCK_IDLE_MS + 1)
    })
    expect(ctl.locked).toBe(false)
    // the watchdog does not stop a run that may still be alive
    expect(onStop).not.toHaveBeenCalled()
  })

  it('run activity re-arms the watchdog', async () => {
    let state = running()
    act(() => root.render(createElement(Probe, { state })))
    await flush()
    act(() => {
      vi.advanceTimersByTime(TRANSLATION_LOCK_IDLE_MS - 1000)
    })
    state = reduceRunStatus(state, { type: 'tool-start', name: 'translate_blocks' })
    act(() => root.render(createElement(Probe, { state })))
    act(() => {
      vi.advanceTimersByTime(TRANSLATION_LOCK_IDLE_MS - 1000)
    })
    expect(ctl.locked).toBe(true)
  })

  it('a probe that fails leaves the document unlocked', async () => {
    probe.mockRejectedValueOnce(new Error('no bridge'))
    act(() => root.render(createElement(Probe, { state: running() })))
    await flush()
    expect(ctl.locked).toBe(false)
  })
})
