/**
 * Where the Korean original of a translated document lives. In a translation
 * project the output copy `<project>/output/<name>` has its original copy at
 * `<project>/source/<name>` (same name, decision 0102); a folder is a project
 * only when it holds `.tandem/project.json`. Pure: existence checks are passed in.
 */
import { posix, win32 } from 'node:path'

/** the biggest original the popup reads (a bigger document falls back to manual paste) */
export const COMPARE_SOURCE_MAX_BYTES = 40 * 1024 * 1024

export async function translationSourceCopy(
  outputPath: string,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const path = platform === 'win32' ? win32 : posix
  if (!path.isAbsolute(outputPath)) return null
  const outputDir = path.dirname(outputPath)
  if (path.basename(outputDir) !== 'output') return null
  const projectDir = path.dirname(outputDir)
  const name = path.basename(outputPath)
  if (!/\.docx$/i.test(name)) return null
  if (!(await exists(path.join(projectDir, '.tandem', 'project.json')))) return null
  const source = path.join(projectDir, 'source', name)
  return (await exists(source)) ? source : null
}
