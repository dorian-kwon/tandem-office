import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { parseFileToText, stopParseSidecar } from '@genoffice/file-parse'
import type { WikiFinalResult } from '../../shared/translate-api'
import { stripMarkup } from '../file-index/extract'
import { MAX_BODY_CHARS } from '../file-index/limits'
import { createCliRunner } from '../mcp/cli-runner'
import { ingestFinalNote } from './wiki-final-notes'
import type { WikiImportOptions } from './wiki-import'

const { paths, profileDir, lang, cliEntry } = workerData as WikiImportOptions & { paths: string[] }

async function learn(path: string): Promise<WikiFinalResult['status']> {
  const before = await stat(path)
  if (!before.isFile()) return 'failed'
  const ext = extname(path).toLowerCase()
  let scratch: string | undefined
  let input = path
  try {
    if (ext === '.xls') {
      scratch = await mkdtemp(join(tmpdir(), 'tandem-wiki-xls-'))
      input = join(scratch, 'workbook.xlsx')
      const cli = createCliRunner({ executable: process.execPath, entry: cliEntry })
      if (!(await cli.run(['convert', path, '--to', 'xlsx', '--out', input])).ok) return 'failed'
    }
    const parsed = await parseFileToText(input, { maxChars: MAX_BODY_CHARS })
    if (!parsed.ok || parsed.kind !== 'text') return 'failed'
    const body = parsed.text ?? ''
    const text = ext === '.html' || ext === '.htm' ? stripMarkup(body) : body
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(path)) hash.update(bytes)
    const after = await stat(path)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino)
      return 'failed'
    return await ingestFinalNote(
      profileDir,
      lang,
      basename(path),
      text.slice(0, MAX_BODY_CHARS),
      hash.digest('hex'),
    )
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

async function run(): Promise<void> {
  try {
    for (const [index, path] of paths.entries()) {
      const status = await learn(path).catch(() => 'failed' as const)
      parentPort!.postMessage({ index, status })
    }
  } finally {
    stopParseSidecar()
    parentPort!.close()
  }
}
void run()
