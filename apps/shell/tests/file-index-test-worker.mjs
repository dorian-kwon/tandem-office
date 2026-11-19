// Use the production scan and database writer. Only the expensive parser is a
// double, so these fixtures can wedge or exhaust a worker without large files.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { basename } from 'node:path'
import { require as loadTs } from 'tsx/cjs/api'

const { runIndexWorker } = loadTs('../src/main/file-index/worker.ts', import.meta.url)
const hoard = []
runIndexWorker(async (path) => {
  if (basename(path) === 'poison.pdf') return new Promise(() => {})
  if (basename(path) === 'hog.xlsx') {
    for (;;) hoard.push(new Array(1 << 18).fill(1))
  }
  if (basename(path) === 'paused.md') {
    const text = await readFile(path, 'utf8')
    await writeFile(path + '.started', '')
    while (!existsSync(path + '.release')) await delay(5)
    return { kind: 'text', text }
  }
  return { kind: 'text', text: 'body of ' + path }
})
