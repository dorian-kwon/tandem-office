import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, relative } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { parseFileToText, stopParseSidecar } from '@genoffice/file-parse'
import type { WikiFinalResult } from '../../shared/translate-api'
import { stripMarkup } from '../file-index/extract'
import { MAX_BODY_CHARS } from '../file-index/limits'
import { createCliRunner } from '../mcp/cli-runner'
import { ingestFinalNote } from './wiki-final-notes'
import type { WikiImportOptions } from './wiki-import'

// Document parsers and the XLS converter reopen paths. Give them a private snapshot
// made from one checked file descriptor so a moved file or substituted link isn't parsed.
async function snapshotProjectResult(
  path: string,
  projectDir: string,
  snapshot: string,
): Promise<string> {
  const output = join(projectDir, 'output')
  const ensureFolder = async () => {
    if (relative(output, dirname(path)) !== '' || relative(output, await realpath(output)) !== '')
      throw new Error('Expected a project output file')
  }
  await ensureFolder()
  const picked = await lstat(path, { bigint: true })
  if (!picked.isFile() || picked.nlink !== 1n) throw new Error('Expected a regular project result')
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const before = await handle.stat({ bigint: true })
    await ensureFolder()
    const live = await lstat(path, { bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.dev !== picked.dev ||
      before.ino !== picked.ino ||
      live.ino !== before.ino ||
      live.dev !== before.dev ||
      !live.isFile()
    )
      throw new Error('Project result changed while opening')
    const copy = await open(snapshot, 'wx', 0o600)
    const hash = createHash('sha256')
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024)
      let copied = 0n
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        copied += BigInt(bytesRead)
        if (copied > before.size) throw new Error('Project result grew during import')
        const chunk = buffer.subarray(0, bytesRead)
        hash.update(chunk)
        await copy.writeFile(chunk)
      }
    } finally {
      await copy.close()
    }
    const after = await handle.stat({ bigint: true })
    if (after.ctimeNs !== before.ctimeNs || after.size !== before.size)
      throw new Error('Project result changed during import')
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

export async function learnFinalPath(
  path: string,
  options: WikiImportOptions,
): Promise<WikiFinalResult['status'] | 'unchanged-source'> {
  const { projectDir, profileDir, lang, cliEntry, sourceHashes } = options
  const ext = extname(path).toLowerCase()
  let scratch: string | undefined
  let input = path
  try {
    if (projectDir || ext === '.xls') scratch = await mkdtemp(join(tmpdir(), 'tandem-wiki-import-'))
    let revision: string | undefined
    if (projectDir) {
      input = join(scratch!, 'input' + ext)
      revision = await snapshotProjectResult(path, projectDir, input)
      if (sourceHashes?.[basename(path)] === revision) return 'unchanged-source'
    }
    const before = await stat(input)
    if (!before.isFile()) return 'failed'
    if (ext === '.xls') {
      const converted = join(scratch!, 'workbook.xlsx')
      const cli = createCliRunner({ executable: process.execPath, entry: cliEntry })
      if (!(await cli.run(['convert', input, '--to', 'xlsx', '--out', converted])).ok)
        return 'failed'
      input = converted
    }
    const parsed = await parseFileToText(input, { maxChars: MAX_BODY_CHARS })
    if (!parsed.ok || parsed.kind !== 'text') return 'failed'
    const body = parsed.text ?? ''
    const text = ext === '.html' || ext === '.htm' ? stripMarkup(body) : body
    if (!revision) {
      const hash = createHash('sha256')
      for await (const bytes of createReadStream(path)) hash.update(bytes)
      const after = await stat(path)
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        return 'failed'
      revision = hash.digest('hex')
    }
    return await ingestFinalNote(
      profileDir,
      lang,
      basename(path),
      text.slice(0, MAX_BODY_CHARS),
      revision,
      projectDir,
      options.outputNames?.[basename(path)],
      projectDir ? undefined : await realpath(path),
    )
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true })
  }
}

async function run(options: WikiImportOptions & { paths: string[] }): Promise<void> {
  try {
    for (const [index, path] of options.paths.entries()) {
      const status = await learnFinalPath(path, options).catch(() => 'failed' as const)
      parentPort!.postMessage({ index, status })
    }
  } finally {
    stopParseSidecar()
    parentPort!.close()
  }
}
if (parentPort && workerData?.paths) void run(workerData)
