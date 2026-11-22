import { test, expect } from '@playwright/test'
import { mkdir, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Document, Packer, Paragraph, Header } from 'docx'
import { runFingerprint } from '../apps/docs/src/renderer/ai/run-fingerprint'
import { buildAnchoredTextboxParagraphXml } from '@genoffice/docx-engine'
import { buildDocx } from '../packages/docx-engine/tests/helpers/build-docx'
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
  const buffer = await Packer.toBuffer(
    new Document({
      sections: [
        {
          headers: { default: new Header({ children: [new Paragraph('Report title')] }) },
          children: [new Paragraph('Second document.')],
        },
      ],
    }),
  )
  await writeFile(word, buffer)
  const documentXml = await (
    await JSZip.loadAsync(buffer)
  )
    .file('word/document.xml')!
    .async('string')
  const headerId = /<w:headerReference[^>]*r:id="([^"]+)"/.exec(documentXml)![1]!
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
            id: 'format-md',
            name: 'ask_choice',
            input: {
              id: 'outputMode',
              question: 'How should the translated text be placed?',
              options: ['Keep both languages', 'Translate the output copy'],
              recommendedFormat: 'target-only',
            },
          },
        ],
      },
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
      { text: '번역을 마쳤습니다.', hold: true },
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
      {
        toolCalls: [
          {
            id: 'change-word',
            name: 'translate_blocks',
            input: {
              blocks: [
                {
                  index: 0,
                  fp: runFingerprint(['Second document.']),
                  segments: ['두 번째 문서입니다.'],
                },
              ],
            },
          },
        ],
      },
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
      // A premature completion claim must lead back to the outstanding header.
      {
        toolCalls: [
          {
            id: 'change-header',
            name: 'translate_blocks',
            input: {
              blocks: [
                {
                  story: 'header:default:' + headerId,
                  paragraph: 0,
                  fp: runFingerprint(['Report title']),
                  segments: ['보고서 제목'],
                },
              ],
            },
          },
        ],
      },
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
      { text: 'PROJECT_ALREADY_TRANSLATED\nPROJECT_TRANSLATION_COMPLETE' },
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
    await expect(second.getByTestId('project-batch-open-result')).toHaveCount(0)
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
    await expect(third.getByTestId('project-batch-open-result')).toBeVisible()
    await expect(third).toContainText(
      'The editor has not confirmed that the entire document is translated.',
    )
    await expect(progress.getByTestId('project-batch-retry')).toBeEnabled()
    expect(await readdir(join(dir, 'output'))).not.toContain('excluded.md')

    expect(
      (await recorded(app)).streams.some((r) =>
        r.includes(
          'Batch translation formatting (outputMode): Translate the text in the output copy.',
        ),
      ),
    ).toBe(true)
    const verification = (await recorded(app)).streams.filter((r) =>
      r.includes('Report the status of the translation you just worked on'),
    )
    expect(verification).toHaveLength(2)
    expect(verification[0]).toContain('번역을 마쳤습니다.')
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
    expect(await zip.file('word/header1.xml')!.async('string')).toContain('보고서 제목')
    await page.getByTestId('project-batch-show-progress').click()
    await second.getByTestId('project-batch-open-result').click()
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const split = await window.aiOfficeTabs.getSplit()
          const tabs = await window.aiOfficeTabs.list()
          if (!split) return null
          return {
            left: tabs.find((t) => t.id === split.aTabId)?.filePath,
            right: tabs.find((t) => t.id === split.bTabId)?.filePath,
            orientation: split.orientation,
            focus: split.focus,
          }
        }),
      )
      .toEqual({
        left: join(dir, 'source', 'second.docx'),
        right: join(dir, 'output', 'second.docx'),
        orientation: 'side',
        focus: 'b',
      })
    expect(await readFile(join(dir, 'source', 'second.docx'))).toEqual(await readFile(word))
  } finally {
    await closeAndSaveVideo(launched, 'project-batch')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})

test('opens the saved batch Word directly at a clipped text box inside its table cell', async () => {
  const root = test.info().outputPath('review-fixtures')
  await mkdir(root, { recursive: true })
  const { dir } = await createProject(root, 'Layout review', 'ko', 'en')
  const name = 'layout.docx'
  const file = join(root, name)
  const caption = 'Original translated caption in the second cell. '.repeat(15)
  const box = buildAnchoredTextboxParagraphXml({
    id: 23,
    anchor: 'paragraph',
    xEmu: 0,
    yEmu: 0,
    widthEmu: 250000,
    heightEmu: 100000,
    paragraphs: [{ runs: [{ text: caption, sizeHalfPoints: 12 }] }],
    wrap: 'none',
    holderLineTwips: 20,
  })
  const bytes = await buildDocx({
    bodyXml:
      '<w:p><w:r><w:t>English guide</w:t></w:r></w:p>' +
      '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1600"/><w:gridCol w:w="1600"/></w:tblGrid><w:tr>' +
      '<w:tc><w:p><w:r><w:t>First cell</w:t></w:r></w:p></w:tc><w:tc><w:p/><w:p><w:r><w:t>Second cell</w:t></w:r></w:p>' +
      box +
      '</w:tc></w:tr></w:tbl><w:p/>',
  })
  await writeFile(file, bytes)
  await addSource(dir, file)
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
    await queueTurns(app, [{ text: 'PROJECT_ALREADY_TRANSLATED\nPROJECT_TRANSLATION_COMPLETE' }])
    await openBatchSelection(page)
    const progress = await submitBatchSelection(page)
    const row = batchRow(progress, name)
    await expect(row).toHaveAttribute('data-batch-state', 'saved', { timeout: 55_000 })
    await expect(row.locator('[data-batch-coverage="verified"]')).toBeVisible()
    const review = row.locator('details[data-batch-layout="review"]')
    await expect(review.locator('summary')).toContainText('1')
    await review.locator('summary').click()
    const location = review.getByTestId('project-batch-open-layout')
    await expect(location).toHaveText(/cell @\d+ · box 0/)
    // Capture the real renderer's navigation reply. Chromium suppresses animation
    // frames for hidden windows, so watching the highlight would be timing-dependent.
    await app.evaluate(({ app, webContents }) => {
      const host = globalThis as unknown as { batchLayoutNav: unknown[] }
      host.batchLayoutNav = []
      const observe = (wc: Electron.WebContents) => {
        const execute = wc.executeJavaScript.bind(wc)
        wc.executeJavaScript = async (code, gesture) => {
          const reply = await execute(code, gesture)
          if (code.includes('window.__genofficeControl') && code.includes('"textBox"'))
            host.batchLayoutNav.push(reply)
          return reply
        }
      }
      for (const wc of webContents.getAllWebContents()) observe(wc)
      app.on('web-contents-created', (_event, wc) => observe(wc))
    })
    await location.click()
    const response = () =>
      app.evaluate(() => (globalThis as unknown as { batchLayoutNav: unknown[] }).batchLayoutNav)
    await expect
      .poll(response, { timeout: 25_000 })
      .toContainEqual({ status: 'ok', result: { block: 1, box: 0 } })
    const paths = await page.evaluate(async () => {
      const split = await window.aiOfficeTabs.getSplit()
      const tabs = await window.aiOfficeTabs.list()
      return (
        split &&
        [split.aTabId, split.bTabId].map((id) => tabs.find((tab) => tab.id === id)?.filePath)
      )
    })
    expect(paths).toEqual([join(dir, 'source', name), join(dir, 'output', name)])
    expect(await readFile(join(dir, 'source', name))).toEqual(Buffer.from(bytes))
  } finally {
    await closeAndSaveVideo(launched, 'project-batch')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
