import { test, expect } from '@playwright/test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProject, addSource } from '@genoffice/translate-project'
import { launchShell, closeAndSaveVideo } from './helpers'
import {
  queuePicks,
  queueTurns,
  recorded,
  releaseHeldTurn,
  stubEverything,
} from './project-folder-user-lib'
import { batchRow, startBatchWithFiles } from './project-batch-ui'

test('batch chat serves the selected documents in one conversation and saves their edits', async () => {
  const root = test.info().outputPath('project')
  await mkdir(root, { recursive: true })
  const { dir } = await createProject(root, 'Batch chat', 'en', 'ko')
  const files = ['first.md', 'second.md']
  for (const name of files) {
    const path = join(root, name)
    await writeFile(path, 'Source.')
    await addSource(dir, path)
  }
  const manual = '이 문단은 검토자가 이미 수정했습니다.'
  await writeFile(join(dir, 'output', files[0]!), 'Source.\n\n' + manual)
  const launched = await launchShell({
    onboardingSeen: true,
    videoDir: 'project-batch-chat',
    hideUpdateWindows: true,
    recordVideo: false,
  })
  const { app, page } = launched
  const edit = (id: string, find: string, replace: string) => ({
    toolCalls: [
      {
        id,
        name: 'apply_ops',
        input: {
          intent: 'translation',
          ops: [{ op: 'replaceText', target: { start: 0 }, find, replace }],
        },
      },
    ],
  })
  try {
    await stubEverything(app)
    await queuePicks(app, [dir])
    await page.getByRole('button', { name: 'Open existing project folder' }).click()
    await queueTurns(app, [
      edit('first-translation', 'Source.', '번역본.'),
      { text: 'PROJECT_TRANSLATION_COMPLETE', hold: true },
      { text: '현재 문서만 확인했습니다.' },
      edit('second-translation', 'Source.', '번역본.'),
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
    ])
    const progress = await startBatchWithFiles(page, files)
    const chat = progress.getByRole('region', { name: 'Batch chat' })
    const input = chat.getByRole('textbox', { name: 'Batch chat' })
    const button = chat.locator('.ai-send-btn')
    await page.setViewportSize({ width: 1100, height: 740 })
    const filesPane = progress.locator('.batch-progress-files')
    const left = await filesPane.boundingBox()
    const right = await chat.boundingBox()
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x)
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as Record<string, unknown>).__pfHeldReply))
      .toBe('function')
    // A short window used to let the form paint over the Stop and Close buttons.
    await page.setViewportSize({ width: 640, height: 420 })
    const upper = await filesPane.boundingBox()
    const lower = await chat.boundingBox()
    expect(upper!.y + upper!.height).toBeLessThanOrEqual(lower!.y)
    const footer = progress.locator('.modal-buttons')
    const ensureChatClearsFooter = async () => {
      await button.scrollIntoViewIfNeeded()
      const sendBox = await button.boundingBox()
      const footerBox = await footer.boundingBox()
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(footerBox!.y)
      await progress.getByTestId('project-batch-close').click({ trial: true })
    }
    const here = '  지금 이 문서만 확인해줘.\n표기는 그대로.  '
    await input.fill(here)
    await ensureChatClearsFooter()
    await progress.getByTestId('project-batch-stop').click({ trial: true })
    await button.click()
    await expect(
      progress
        .getByTestId('project-batch-chat-history')
        .locator('article')
        .first()
        .locator('strong'),
    ).toHaveText(['first.md'])
    await releaseHeldTurn(app)
    await expect(batchRow(progress, 'second.md')).toHaveAttribute('data-batch-state', 'saved', {
      timeout: 60000,
    })
    const all = '  문서 전체 그렇게 해줘.\n단어 사이  공백도 유지해줘.  '
    await queueTurns(app, [
      {
        toolCalls: [
          { id: 'select-first', name: 'select_batch_document', input: { file: files[0] } },
        ],
      },
      edit('change-first', '번역본.', '검토 완료.'),
      {
        toolCalls: [
          { id: 'select-second', name: 'select_batch_document', input: { file: files[1] } },
        ],
      },
      edit('change-second', '번역본.', '검토 완료.'),
      { partialText: '두 문서의 표기를', text: ' 함께 검토했습니다.', hold: true },
    ])
    await input.fill(all)
    await ensureChatClearsFooter()
    await button.click()
    const last = progress.getByTestId('project-batch-chat-history').locator('article').last()
    await expect(last.locator('.kb-ask-assistant')).toHaveText('두 문서의 표기를')
    await releaseHeldTurn(app)
    await expect(last.locator('.kb-ask-assistant')).toHaveText(
      '두 문서의 표기를 함께 검토했습니다.',
      { timeout: 60000 },
    )
    await expect(last.locator('.kb-ask-user')).toHaveText(all.trim())
    await expect(progress.getByTestId('project-batch-rerun-all')).toBeEnabled()
    for (const file of files) {
      await expect(
        batchRow(progress, file).getByRole('button', { name: 'Retranslate ' + file }),
      ).toBeEnabled()
    }
    const requests = (await recorded(app)).streams.map(
      (s) => JSON.parse(s) as { messages: { role: string; text?: string }[] },
    )
    const fresh = requests.map((r) => r.messages.at(-1)).filter((m) => m?.role === 'user')
    expect(fresh.filter((m) => m?.text === here)).toHaveLength(1)
    expect(fresh.filter((m) => m?.text === all)).toHaveLength(1)
    for (const file of files) {
      expect(await readFile(join(dir, 'output', file), 'utf8')).toContain('검토 완료.')
      expect(await readFile(join(dir, 'source', file), 'utf8')).toBe('Source.')
    }

    // Rerunning a saved file keeps the existing output and leaves its sibling untouched.
    await queueTurns(app, [
      edit('one-again', '검토 완료.', '개별 재번역.'),
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
    ])
    await batchRow(progress, files[0]!).getByTestId('project-batch-rerun-file').click()
    const outputText = (name: string) => readFile(join(dir, 'output', name), 'utf8')
    await expect.poll(() => outputText(files[0]!)).toContain('개별 재번역.')
    expect(await outputText(files[1]!)).toContain('검토 완료.')
    await expect(batchRow(progress, files[1]!)).toHaveAttribute('data-batch-state', 'saved')
    await queueTurns(app, [
      edit('all-again-first', '개별 재번역.', '전체 재번역.'),
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
      edit('all-again-second', '검토 완료.', '전체 재번역.'),
      { text: 'PROJECT_TRANSLATION_COMPLETE' },
    ])
    await progress.getByTestId('project-batch-rerun-all').click()
    for (const file of files) await expect.poll(() => outputText(file)).toContain('전체 재번역.')
    expect(await outputText(files[0]!)).toContain(manual)
    await expect(last.locator('.kb-ask-assistant')).toHaveText(
      '두 문서의 표기를 함께 검토했습니다.',
    )
  } finally {
    await closeAndSaveVideo(launched, 'project-batch-chat')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
