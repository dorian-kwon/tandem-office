import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import JSZip from 'jszip'
import { createProject, addSource } from '@genoffice/translate-project'
import { launchShell, closeAndSaveVideo } from './helpers'
import {
  queuePicks,
  queueTurns,
  recorded,
  releaseHeldTurn,
  stubEverything,
} from './project-folder-user-lib'
import { batchRow, openBatchSelection, submitBatchSelection } from './project-batch-ui'

test('project batch saves only selected documents, shows live progress and retries only the failed file', async () => {
  const info = test.info()
  const root = info.outputPath('project-fixtures')
  await mkdir(root, { recursive: true })
  const { dir } = await createProject(root, 'Batch test', 'en', 'ko')
  const markdown = join(root, 'first.md')
  const word = join(root, 'second.docx')
  await writeFile(markdown, 'First paragraph.')
  await writeFile(word, await readFile(resolve(__dirname, '../fixtures/generated/simple.docx')))
  await addSource(dir, markdown)
  await addSource(dir, word)
  const already = join(root, 'third.md')
  await writeFile(already, '이미 번역된 문서입니다.')
  await addSource(dir, already)
  const excluded = join(root, 'excluded.md')
  await writeFile(excluded, 'Leave this document out.')
  await addSource(dir, excluded)
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'project-batch',
  })
  try {
    const { app, page } = launched
    await stubEverything(app)
    await queuePicks(app, [dir])
    await page.getByRole('button', { name: 'Open existing project folder' }).click()
    await expect(page.getByTestId('project-batch-start')).toBeVisible()
    await queueTurns(app, [
      {
        toolCalls: [
          {
            id: 'change-md',
            name: 'apply_ops',
            input: {
              intent: 'translation',
              ops: [
                {
                  op: 'replaceText',
                  target: { start: 0 },
                  find: 'First paragraph.',
                  replace: '첫 문단입니다.',
                },
              ],
            },
          },
        ],
      },
      { text: 'PROJECT_TRANSLATION_COMPLETE', hold: true },
      {
        toolCalls: [
          {
            id: 'change-word',
            name: 'replace_blocks',
            input: { startBlockIndex: 1, endBlockIndex: 1, html: '<p>두 번째 문서입니다.</p>' },
          },
        ],
      },
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
      { text: 'PROJECT_ALREADY_TRANSLATED\nPROJECT_TRANSLATION_COMPLETE' },
    ])
    await page.evaluate(() => {
      const obs = new MutationObserver(() => {
        if (document.querySelector('.tab-item.active:not(.tab-home)'))
          document.body.dataset.batchStoleFocus = 'yes'
      })
      obs.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['class'],
      })
    })
    const chooser = await openBatchSelection(page)
    const all = chooser.getByRole('checkbox', { name: 'Select all', exact: true })
    await expect(all).toBeChecked()
    await all.uncheck()
    await expect(chooser.getByTestId('project-batch-submit')).toBeDisabled()
    await all.check()
    await chooser.getByRole('checkbox', { name: 'excluded.md', exact: true }).uncheck()
    expect((await recorded(app)).streams).toHaveLength(0)

    const progress = await submitBatchSelection(page)
    const first = batchRow(progress, 'first.md')
    const second = batchRow(progress, 'second.docx')
    const third = batchRow(progress, 'third.md')
    await expect(batchRow(progress, 'excluded.md')).toHaveCount(0)
    await expect(first).toHaveAttribute('data-batch-state', 'running')
    await expect(second).toHaveAttribute('data-batch-state', 'waiting')
    // The mock pauses the completion reply after the editor has applied its first edit.
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as Record<string, unknown>).__pfHeldReply))
      .toBe('function')
    await expect(first.locator('[data-batch-operations="1"]')).toContainText('Edits: 1')
    await progress.getByTestId('project-batch-close').click()
    await expect(progress).toHaveCount(0)
    await page.getByTestId('project-batch-show-progress').click()
    await expect(first).toHaveAttribute('data-batch-state', 'running')
    await expect(first.locator('[data-batch-operations="1"]')).toBeVisible()
    await releaseHeldTurn(app)
    await expect(first).toHaveAttribute('data-batch-state', 'saved', { timeout: 80_000 })
    await expect(second).toHaveAttribute('data-batch-state', 'saved', { timeout: 80_000 })
    await expect(third).toHaveAttribute('data-batch-state', 'failed', { timeout: 80_000 })
    await expect(third).toContainText(
      'The editor has not confirmed that the entire document is translated.',
    )
    await expect(progress.getByTestId('project-batch-retry')).toBeEnabled()
    expect(await readdir(join(dir, 'output'))).not.toContain('excluded.md')

    const firstSave = await stat(join(dir, 'output', 'first.md'))
    const secondSave = await stat(join(dir, 'output', 'second.docx'))
    const requestsBeforeRetry = (await recorded(app)).streams.length
    await queueTurns(app, [
      {
        toolCalls: [
          { id: 'read-third', name: 'read_blocks', input: { startIndex: 0, endIndex: 0 } },
        ],
      },
      { text: 'PROJECT_ALREADY_TRANSLATED\nPROJECT_TRANSLATION_COMPLETE' },
    ])
    await progress.getByTestId('project-batch-retry').click()
    await expect(third).toHaveAttribute('data-batch-state', 'saved', { timeout: 80_000 })
    await expect(first).toHaveAttribute('data-batch-state', 'saved')
    await expect(second).toHaveAttribute('data-batch-state', 'saved')
    expect((await recorded(app)).streams).toHaveLength(requestsBeforeRetry + 2)
    expect((await stat(join(dir, 'output', 'first.md'))).mtimeMs).toBe(firstSave.mtimeMs)
    expect((await stat(join(dir, 'output', 'second.docx'))).mtimeMs).toBe(secondSave.mtimeMs)
    expect(await readdir(join(dir, 'output'))).not.toContain('excluded.md')
    await progress.getByTestId('project-batch-close').click()
    expect(await readFile(join(dir, 'output', 'third.md'), 'utf8')).toBe('이미 번역된 문서입니다.')
    await expect(page.getByTestId('project-batch-start')).toBeVisible()
    expect(await page.locator('body').getAttribute('data-batch-stole-focus')).toBeNull()
    expect(await readFile(join(dir, 'output', 'first.md'), 'utf8')).toContain('첫 문단입니다.')
    const zip = await JSZip.loadAsync(await readFile(join(dir, 'output', 'second.docx')))
    expect(await zip.file('word/document.xml')!.async('string')).toContain('두 번째 문서입니다.')
    expect(await readFile(join(dir, 'source', 'first.md'), 'utf8')).toBe('First paragraph.')
    expect(await readFile(join(dir, 'source', 'second.docx'))).toEqual(await readFile(word))
  } finally {
    await closeAndSaveVideo(launched, 'project-batch')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
