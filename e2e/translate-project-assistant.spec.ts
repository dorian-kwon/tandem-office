import { expect, test } from '@playwright/test'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { closeAndSaveVideo, launchShell } from './helpers'
import { batchRow, startBatchWithFiles } from './project-batch-ui'
import { queuePicks, queueTurns, recorded, stubEverything } from './project-folder-user-lib'

test('project AI edits a registered Word document and returns its saved editor reply to the project', async () => {
  test.setTimeout(150_000)
  const root = test.info().outputPath('projects')
  await mkdir(root, { recursive: true })
  const file = 'guide.docx'
  const source = test.info().outputPath(file)
  await copyFile(resolve('fixtures/generated/simple.docx'), source)
  const glossary = test.info().outputPath('terms.csv')
  await writeFile(glossary, 'source,target\nroute,GUIDE_TERM_413\n')
  const launched = await launchShell({
    onboardingSeen: true,
    hideUpdateWindows: true,
    recordVideo: false,
    videoDir: 'translate-project-assistant',
  })
  const { app, page } = launched
  try {
    await stubEverything(app)
    await queuePicks(app, [root, source, glossary])
    await page.getByRole('button', { name: 'Translation', exact: true }).first().click()
    await page.getByRole('button', { name: 'New project' }).click()
    await page.getByLabel('Project name').fill('Guide project')
    await page.getByRole('button', { name: 'Choose folder' }).click()
    await expect(page.getByText(root)).toBeVisible()
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByText('Guide project', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Add files' }).first().click()
    await expect(page.getByText(file, { exact: true }).first()).toBeVisible()
    await page.getByRole('button', { name: 'Add files' }).nth(2).click()
    await expect(page.getByText('terms.csv', { exact: true })).toBeVisible()
    await page.getByLabel('Project prompt').fill('GUIDE_PROJECT_413')
    await page.getByLabel('Project prompt').blur()
    const custom = page.getByLabel('Custom instruction')
    await custom.fill('GUIDE_STYLE_413')
    await custom.blur()
    const request = 'Change the second paragraph to the updated schedule.'
    const marker = 'Updated schedule from the project chat.'
    const editorReply = 'The Word editor revised the schedule.'
    const projectReply = 'The updated schedule was saved.'
    await queueTurns(app, [
      {
        toolCalls: [
          { id: 'edit-file', name: 'run_document_ai', input: { file, instruction: request } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'edit-paragraph',
            name: 'replace_blocks',
            input: {
              startBlockIndex: 1,
              endBlockIndex: 1,
              html: '<p>' + marker + '</p>',
            },
          },
        ],
      },
      { text: editorReply },
      { text: projectReply },
    ])
    const panel = page.getByTestId('project-assistant')
    const closeAi = panel.getByRole('button', { name: 'Close project AI' })
    const openAi = panel.getByRole('button', { name: 'Open project AI' })
    await panel.locator('textarea').fill(request)
    await closeAi.click()
    await expect(openAi).toBeFocused()
    await expect(panel.locator('textarea')).toBeHidden()
    await expect(openAi).toHaveAttribute('aria-expanded', 'false')
    await openAi.press('Enter')
    await expect(panel.locator('textarea')).toHaveValue(request)
    await panel.locator('.ai-send-btn').click()
    await closeAi.click()
    await expect(panel.getByText(projectReply)).toBeAttached({ timeout: 130_000 })
    await openAi.click()
    await expect(panel.getByRole('log')).toContainText(projectReply, { timeout: 130_000 })
    const streams = (await recorded(app)).streams
    expect(streams.length).toBe(4)
    const projectMarkers = ['GUIDE_PROJECT_413', 'GUIDE_TERM_413', 'GUIDE_STYLE_413']
    for (const marker of projectMarkers) {
      expect(JSON.parse(streams[1]).system).toContain(marker)
    }
    expect(streams[2]).toContain('edit-paragraph')
    expect(streams[3]).toContain(editorReply)
    const zip = await JSZip.loadAsync(await readFile(join(root, 'Guide project', 'output', file)))
    expect(await zip.file('word/document.xml')!.async('string')).toContain(marker)
    expect(await readFile(join(root, 'Guide project', 'source', file))).toEqual(
      await readFile(source),
    )
    await expect(page.locator('.tab-item:not(.tab-home)')).toHaveCount(0)
    await queueTurns(app, [
      {
        toolCalls: [
          {
            id: 'batch-edit',
            name: 'replace_blocks',
            input: { startBlockIndex: 1, endBlockIndex: 1, html: '<p>단체 방문 일정</p>' },
          },
        ],
      },
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
    ])
    const progress = await startBatchWithFiles(page, [file])
    await expect(batchRow(progress, file)).toHaveAttribute('data-batch-state', 'saved', {
      timeout: 100_000,
    })
    await progress.getByTestId('project-batch-close').click()
    const allTurns = (await recorded(app)).streams
    expect(allTurns).toHaveLength(6)
    for (const marker of projectMarkers) {
      expect(JSON.parse(allTurns[4]).system).toContain(marker)
    }
  } finally {
    await closeAndSaveVideo(launched, 'translate-project-assistant')
  }
})
