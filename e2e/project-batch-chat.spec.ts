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

test('batch chat forwards the exact current and all-document requests and saves each reply', async () => {
  const root = test.info().outputPath('project')
  await mkdir(root, { recursive: true })
  const { dir } = await createProject(root, 'Batch chat', 'en', 'ko')
  const files = ['first.md', 'second.md']
  for (const name of files) {
    const path = join(root, name)
    await writeFile(path, 'Source.')
    await addSource(dir, path)
  }
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
    const input = progress.getByTestId('project-batch-chat-input')
    const button = progress.getByTestId('project-batch-chat-send')
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as Record<string, unknown>).__pfHeldReply))
      .toBe('function')
    const here = '  지금 이 문서만 확인해줘.\n표기는 그대로.  '
    await input.fill(here)
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
      edit('change-first', '번역본.', '검토 완료.'),
      { text: '첫 파일 완료.' },
      edit('change-second', '번역본.', '검토 완료.'),
      { text: '둘째 파일 완료.' },
    ])
    await input.fill(all)
    await button.click()
    const last = progress.getByTestId('project-batch-chat-history').locator('article').last()
    await expect(last).toContainText('둘째 파일 완료.', { timeout: 60000 })
    const requests = (await recorded(app)).streams.map(
      (s) => JSON.parse(s) as { messages: { role: string; text?: string }[] },
    )
    const fresh = requests.map((r) => r.messages.at(-1)).filter((m) => m?.role === 'user')
    expect(fresh.filter((m) => m?.text === here)).toHaveLength(1)
    expect(fresh.filter((m) => m?.text === all)).toHaveLength(2)
    for (const file of files) {
      expect(await readFile(join(dir, 'output', file), 'utf8')).toContain('검토 완료.')
      expect(await readFile(join(dir, 'source', file), 'utf8')).toBe('Source.')
    }
  } finally {
    await closeAndSaveVideo(launched, 'project-batch-chat')
    await rm(launched.userDataDir, { recursive: true, force: true })
  }
})
