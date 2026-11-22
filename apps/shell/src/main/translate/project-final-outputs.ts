import { lstat, readdir, realpath } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import type { ProjectFile } from '@genoffice/translate-project'
import { TranslateIpcError } from '../../shared/translate-api'
import { appForPath } from '../app-routing'
import { isResultOf, plainFileName } from './open-translation'

/** Numbered files that our PDF, OCR and workbook writers produce are revisions of one result. */
export async function projectFinalOutputs(projectDir: string, project: ProjectFile) {
  const output = join(projectDir, 'output')
  const info = await lstat(output).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null
    throw err
  })
  const paths: string[] = []
  const outputNames: Record<string, string> = Object.create(null)
  if (!info) return { paths, outputNames }
  if (!info.isDirectory() || relative(output, await realpath(output)) !== '')
    throw new TranslateIpcError('INVALID_ARGUMENT', 'Invalid project output folder.')

  const sourceNames = new Set(project.sources.map(({ file }) => file))
  const groups = new Map<string, string[]>()
  for (const entry of await readdir(output, { withFileTypes: true })) {
    const name = entry.name
    if (
      !entry.isFile() ||
      !plainFileName(name) ||
      name.startsWith('.') ||
      name.startsWith('~$') ||
      !appForPath(name)
    )
      continue
    const ext = extname(name)
    const base = name.slice(0, -ext.length).replace(/ \(\d+\)$/, '') + ext
    const numbered =
      base !== name &&
      !sourceNames.has(name) &&
      !sourceNames.has(base) &&
      project.sources.some(
        (source) =>
          isResultOf(source, base, project.targetLang) &&
          isResultOf(source, name, project.targetLang),
      )
    const key = numbered ? base : name
    const names = groups.get(key)
    if (names) names.push(name)
    else groups.set(key, [name])
  }

  for (const [key, names] of groups) {
    let name = names[0]!
    if (names.length > 1) {
      // Same selection rule as "open existing translation": use the most recent save.
      let newest = -Infinity
      for (const candidate of names.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))) {
        const file = await lstat(join(output, candidate)).catch((err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') return null
          throw err
        })
        if (file?.isFile() && file.nlink === 1 && file.mtimeMs > newest) {
          name = candidate
          newest = file.mtimeMs
        }
      }
      if (newest === -Infinity) continue
    }
    paths.push(join(output, name))
    if (name !== key) outputNames[name] = key
  }
  return { paths: paths.sort(), outputNames }
}
