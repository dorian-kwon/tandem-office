import type { Lang } from '@genoffice/i18n'
import { withProjectLock } from '@genoffice/translate-project'
import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { atomicWriteFile } from '../atomic-write'
import { syncWikiGraph } from './wiki-graph'
import { FINAL_CATALOG, FINAL_NOTES_FOLDER } from './wiki-vault'

// Existing vaults acquire the graph the next time they are explicitly opened.
// Recheck metadata because editing Obsidian properties need not change directory mtime.
const HUBS = [
  'index.md',
  FINAL_CATALOG,
  'document-types.md',
  'institutions.md',
  'industries.md',
  'style.md',
]
const CHECKPOINT = 'wiki-graph-migration-v1.json'

async function inspect(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function snapshot(vaultPath: string, lang: Lang) {
  const hash = createHash('sha256').update('graph-3\0').update(lang)
  const paths: string[] = []
  function track(name: string, stat: BigIntStats | undefined) {
    hash.update(
      JSON.stringify([
        name,
        stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) : null,
      ]),
    )
  }
  for (const name of [...HUBS, 'categories']) {
    const stat = await inspect(join(vaultPath, name))
    if (stat && (name === 'categories' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n))
      throw new Error('Untrusted translation wiki entry: ' + name)
    track(name, stat)
  }
  const folder = join(vaultPath, FINAL_NOTES_FOLDER)
  const directory = await inspect(folder)
  if (directory && !directory.isDirectory()) throw new Error('Expected a document notes directory')
  if (directory) {
    const names = (await readdir(folder))
      .filter((name) => name.toLowerCase().endsWith('.md'))
      .sort()
    // Read metadata in small groups for large network/synchronized vaults.
    for (let i = 0; i < names.length; i += 32) {
      const group = names.slice(i, i + 32)
      const stats = await Promise.all(group.map((name) => inspect(join(folder, name))))
      for (const [j, name] of group.entries()) {
        const stat = stats[j]
        if (!stat?.isFile() || stat.nlink !== 1n) continue
        paths.push(join(folder, name))
        track(name, stat)
      }
    }
  }
  return { paths, signature: hash.digest('hex') }
}

async function previousCheckpoint(path: string): Promise<string | undefined> {
  const expected = await inspect(path)
  if (!expected) return undefined
  if (!expected.isFile() || expected.nlink !== 1n)
    throw new Error('Expected a regular wiki migration checkpoint')
  if (expected.size > 1024n) return undefined
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  )
  try {
    const stat = await file.stat({ bigint: true })
    if (expected.ino !== stat.ino || expected.dev !== stat.dev || stat.size > 1024n)
      return undefined
    try {
      return JSON.parse(await file.readFile('utf8')).signature
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return undefined
      throw error
    }
  } finally {
    await file.close()
  }
}

export function migrateWikiGraph(vaultPath: string, lang: Lang, force = false): Promise<void> {
  return withProjectLock(vaultPath, async () => {
    if (!isAbsolute(vaultPath) || !(await inspect(vaultPath))?.isDirectory())
      throw new Error('Expected a translation wiki vault')
    const cache = join(dirname(vaultPath), CHECKPOINT)
    let before = await snapshot(vaultPath, lang)
    if ((await previousCheckpoint(cache)) === before.signature && !force) return
    for (let pass = 0; pass < 2; pass++) {
      await syncWikiGraph(vaultPath, before.paths, lang)
      // A note's properties can change in Obsidian while other pages are being written.
      // Confirm a stable pass before checkpointing; a later open retries a busy vault.
      const after = await snapshot(vaultPath, lang)
      if (before.signature === after.signature) {
        await atomicWriteFile(cache, Buffer.from(JSON.stringify({ signature: after.signature })))
        return
      }
      before = after
    }
  })
}
