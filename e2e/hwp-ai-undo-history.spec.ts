import { expect, test } from '@playwright/test'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

test('the built HWP studio keeps manual undo while skipping disabled AI history', async () => {
  test.setTimeout(120_000)
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'hwp-ai-undo',
    hideUpdateWindows: true,
  })
  try {
    // The current release home exposes translation projects; open via the same shell API.
    await launched.page.evaluate(() => window.aiOffice.newHwp())
    const hwp = await waitForPageWithUrl(launched.app, '://hwp/')
    await hwp.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 })
    const result = await hwp.evaluate(async () => {
      const iframe = document.querySelector('.hwp-editor-host iframe') as HTMLIFrameElement
      const studio = (iframe.contentWindow as any).rhwpStudio
      await studio.plugins.load('ieum-agent')
      let depth = -1
      studio.automation.registerCommand({
        id: 'ext:e2e-undo-depth',
        label: 'Read undo depth for testing',
        execute(services: any) {
          depth = services.getInputHandler().history.undoStack.length
        },
      })
      const historyDepth = async () => {
        await studio.automation.execute('ext:e2e-undo-depth')
        return depth
      }
      const call = (method: string, args: unknown[]) =>
        studio.plugins.invoke('ieum-agent', method, args)
      const initial = await historyDepth()
      const manual = await call('insertParagraphs', ['', null, 'end', ['Manual paragraph']])
      const afterManual = await historyDepth()
      const withoutHistory = await call('invokeAi', [
        'insertParagraphs',
        ['', null, 'end', ['AI without history']],
        false,
      ])
      const afterDisabled = await historyDepth()
      const foreign = await call('foreignChanges', [])
      const withHistory = await call('invokeAi', [
        'insertParagraphs',
        ['', null, 'end', ['AI with history']],
        true,
        'first',
      ])
      const afterEnabled = await historyDepth()
      await studio.automation.execute('edit:undo')
      const text = await call('readText', [])
      await studio.automation.execute('edit:redo')
      const afterRedo = await call('readText', [])
      const guarded = await call('undo', [1, foreign, 'first'])
      const reverted = await call('readText', [])
      await call('invokeAi', ['insertParagraphs', ['', null, 'end', ['Next AI']], true, 'second'])
      const safe = await call('undo', [1, await call('foreignChanges', []), 'second'])
      await call('invokeAi', ['insertParagraphs', ['', null, 'end', ['Next AI']], true, 'third'])
      await call('insertParagraphs', ['', null, 'end', ['Manual from the plugin']])
      const blocked = await call('undo', [1, await call('foreignChanges', []), 'third'])
      const preserved = await call('readText', [])
      return {
        initial,
        manual,
        afterManual,
        withoutHistory,
        afterDisabled,
        withHistory,
        afterEnabled,
        text,
        afterRedo,
        guarded,
        reverted,
        safe,
        blocked,
        preserved,
      }
    })
    expect(result.manual).toMatchObject({ ok: true })
    expect(result.withoutHistory).toMatchObject({ ok: true })
    expect(result.withHistory).toMatchObject({ ok: true })
    expect(result.afterManual).toBe(result.initial + 1)
    expect(result.afterDisabled).toBe(result.afterManual)
    expect(result.afterEnabled).toBe(result.afterDisabled + 1)
    expect(result.text).toContain('Manual paragraph')
    expect(result.text).toContain('AI without history')
    expect(result.text).not.toContain('AI with history')
    expect(result.afterRedo).toContain('AI with history')
    // Native undo/redo counts as a foreign change.
    expect(result.guarded).toMatchObject({ ok: false, undone: 0 })
    expect(result.reverted).toContain('AI with history')
    expect(result.safe).toMatchObject({ ok: true, undone: 1 })
    expect(result.blocked).toMatchObject({ ok: false, undone: 0 })
    expect(result.preserved).toContain('Manual from the plugin')
  } finally {
    await closeAndSaveVideo(launched, 'hwp-ai-undo')
  }
})
