import { expect, test } from '@playwright/test'
import { chmod, copyFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'
import { readHangulText } from './hwp-document-text'
import { queueTurns, stubEverything } from './project-folder-user-lib'

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

for (const format of ['hwp', 'hwpx'] as const) {
  test(`opens an existing ${format.toUpperCase()} and restores its AI edit with native redo`, async () => {
    test.setTimeout(120_000)
    const fixture = join(__dirname, '..', 'apps', 'hwp', 'tests', 'fixtures', 'memo.' + format)
    const file = test.info().outputPath('copy.' + format)
    await copyFile(fixture, file)
    await chmod(file, 0o444)
    const launched = await launchShell({
      onboardingSeen: true,
      hideUpdateWindows: true,
      openFile: file,
      videoDir: 'hwp-ai-undo-' + format,
    })
    try {
      await stubEverything(launched.app)
      const hwp = await waitForPageWithUrl(launched.app, '://hwp/')
      await hwp.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 })
      const before = await readHangulText(hwp)
      expect(before).toContain('본문 메모 앵커')
      expect(before).toContain('표칸')

      // Only the provider response is scripted. The real chat, tool, and studio apply the edit.
      const added = `AI paragraph in ${format.toUpperCase()}`
      await queueTurns(launched.app, [
        {
          toolCalls: [
            { id: 'add', name: 'insert_paragraphs', input: { where: 'end', paragraphs: [added] } },
          ],
        },
        { text: 'Added the paragraph.' },
      ])
      const input = hwp.locator('.ai-composer textarea')
      if (!(await input.isVisible())) await hwp.locator('.ai-rail').click()
      await input.fill('Append one paragraph.')
      await hwp.locator('.ai-composer .ai-send-btn').click()
      await expect(hwp.locator('.ai-changes-revert')).toBeEnabled()
      const after = await readHangulText(hwp)
      expect(after).toContain(added)
      expect(after).toContain('표칸')

      await hwp.locator('.ai-changes-revert').click()
      await expect(hwp.locator('.ai-changes-reverted')).toBeVisible()
      expect(await readHangulText(hwp)).toBe(before)

      const editMenu = hwp.frameLocator('.hwp-editor-host iframe').locator('[data-menu="edit"]')
      await editMenu.locator('.menu-title').click()
      await editMenu.locator('[data-cmd="edit:redo"]').click()
      await expect.poll(() => readHangulText(hwp)).toBe(after)

      await editMenu.locator('.menu-title').click()
      await editMenu.locator('[data-cmd="edit:undo"]').click()
      await expect.poll(() => readHangulText(hwp)).toBe(before)
      expect(await readFile(file)).toEqual(await readFile(fixture))
    } finally {
      await closeAndSaveVideo(launched, 'hwp-ai-undo-' + format)
    }
  })
}

for (const format of ['hwp', 'hwpx'] as const) {
  test(`${format.toUpperCase()} keeps individual translation units across the studio snapshot limit`, async () => {
    test.setTimeout(120_000)
    const fixture = join(__dirname, '..', 'apps', 'hwp', 'tests', 'fixtures', 'memo.' + format)
    const file = test.info().outputPath('translation.' + format)
    await copyFile(fixture, file)
    await chmod(file, 0o444)
    const launched = await launchShell({
      onboardingSeen: true,
      hideUpdateWindows: true,
      recordVideo: false,
      openFile: file,
      videoDir: 'hwp-translation-history',
    })
    try {
      await stubEverything(launched.app)
      const page = await waitForPageWithUrl(launched.app, '://hwp/')
      await page.waitForSelector('.hwp-app[data-phase="ready"]', { timeout: 90_000 })
      // The initial manual edit must still be the next native undo after the whole AI run.
      const initial = await readHangulText(page)
      const rows = Array.from(
        { length: 100 },
        (_, i) => `Row ${i + 1}. Translate this sentence. Translate this sentence.`,
      )
      await page
        .frameLocator('iframe')
        .locator('body')
        .evaluate(async (body, rows) => {
          const studio = (body.ownerDocument.defaultView as any).rhwpStudio
          const result = await studio.plugins.invoke('ieum-agent', 'insertParagraphs', [
            '',
            null,
            'end',
            rows,
          ])
          if (!result.ok) throw new Error('Cannot insert source paragraphs')
        }, rows)
      const before = await readHangulText(page)
      const from = 'Translate this sentence.'
      const to = '이 문장을 번역했습니다.'
      await queueTurns(launched.app, [
        {
          toolCalls: [
            {
              id: 'translate',
              name: 'replace_all',
              input: { find: from, replace: to, undo_unit: 'paragraph' },
            },
          ],
        },
        { text: 'Finished the translation.' },
      ])
      const input = page.locator('.ai-composer textarea')
      if (!(await input.isVisible())) await page.locator('.ai-rail').click()
      await input.fill('Translate the repeated sentence in each paragraph.')
      await page.locator('.ai-composer .ai-send-btn').click()
      await expect(page.getByText('Finished the translation.', { exact: true })).toBeVisible()
      const after = before.replaceAll(from, to)
      expect(await readHangulText(page)).toBe(after)
      await page.locator('.ai-changes-revert').click()
      await expect(page.locator('.ai-changes-reverted')).toBeVisible()
      expect(await readHangulText(page)).toBe(before)

      const native = (command: string, count = 1) =>
        page
          .frameLocator('iframe')
          .locator('body')
          .evaluate(
            async (body, { command, count }) => {
              const studio = (body.ownerDocument.defaultView as any).rhwpStudio
              for (let i = 0; i < count; i++) await studio.automation.execute(command)
            },
            { command, count },
          )
      await native('edit:undo')
      expect(await readHangulText(page)).toBe(initial)
      await native('edit:redo')
      expect(await readHangulText(page)).toBe(before)
      await native('edit:redo')
      const one = await readHangulText(page)
      expect(one.split(to)).toHaveLength(3)
      expect(one).toContain(`Row 1. ${to} ${to}`)
      await native('edit:redo', 99)
      expect(await readHangulText(page)).toBe(after)
      expect(await readFile(file)).toEqual(await readFile(fixture))
    } finally {
      await closeAndSaveVideo(launched, 'hwp-translation-history')
    }
  })
}
