import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, rename, rm } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { renameOwnedAssetDocument } from '../../../markdown/src/main/asset-lifecycle'
import { CONVERSION_ROUTES } from '@genoffice/cli/conversion-routes'
import type { FileConversionInput, FileConversionResult } from '../shared/file-conversion'

export const CONVERSION_EXTENSIONS = Object.keys(CONVERSION_ROUTES)

type Convert = (input: string, target: string, output: string) => Promise<string | void>

function targetsFor(path: string): readonly string[] {
  const extension = extname(path).slice(1).toLowerCase()
  return Object.hasOwn(CONVERSION_ROUTES, extension) ? CONVERSION_ROUTES[extension] : []
}

async function publishNewFile(staged: string, output: string): Promise<void> {
  try {
    await link(staged, output)
  } catch (error) {
    // FAT and some network shares do not support hard links.
    if (
      !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
    await copyFile(staged, output, constants.COPYFILE_EXCL)
  }
}

export async function saveConvertedFile(
  input: string,
  target: string,
  convert: Convert,
  destination?: string,
): Promise<Pick<FileConversionResult, 'outputPath' | 'warning'>> {
  const dir = dirname(destination ?? input)
  const stem = basename(input, extname(input))
  // Keep relative resources valid: PDF -> Markdown writes pictures in assets/
  // beside its output. The temporary document has the real target extension.
  const staged = join(dir, `.convert-${randomUUID()}.${target}`)
  try {
    const warning = await convert(input, target, staged)
    for (let number = 1; ; number++) {
      const suffix = number === 1 ? '' : ` (${number})`
      const output = destination ?? join(dir, `${stem}${suffix}.${target}`)
      try {
        // An explicit destination has already passed the native save dialog's
        // overwrite confirmation. Only replace it after conversion succeeded.
        if (destination) await rename(staged, output)
        else await publishNewFile(staged, output)
      } catch (error) {
        if (!destination && (error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      if (target === 'md' && extname(input).toLowerCase() === '.pdf') {
        // Pictures are already saved. Move the temporary document's ownership
        // references under the final name so the editor can manage them.
        try {
          await renameOwnedAssetDocument(staged, output)
        } catch (error) {
          return {
            outputPath: output,
            warning: [warning, error instanceof Error ? error.message : String(error)]
              .filter(Boolean)
              .join(' '),
          }
        }
      }
      return warning ? { outputPath: output, warning } : { outputPath: output }
    }
  } finally {
    await rm(staged, { force: true }).catch(() => undefined)
  }
}

/** Only paths returned by this window's native picker can become inputs. */
export class FileConversionSession {
  private readonly paths = new Map<string, string>()
  private readonly ids = new Map<string, string>()
  private running = false

  pick(paths: string[]): FileConversionInput[] {
    return [...new Set(paths)].map((path) => {
      const id = this.ids.get(path) ?? randomUUID()
      this.ids.set(path, id)
      this.paths.set(id, path)
      return { id, name: basename(path), displayPath: path, targets: [...targetsFor(path)] }
    })
  }

  async run(
    ids: unknown,
    target: unknown,
    convert: Convert,
    progress: (result: FileConversionResult) => void,
    active: () => boolean,
  ): Promise<FileConversionResult[]> {
    if (this.running) throw new Error('A file conversion is already running.')
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > this.paths.size ||
      typeof target !== 'string'
    )
      throw new Error('Invalid conversion request.')
    const inputs = [...new Set(ids)].map((id: unknown) => {
      const path = typeof id === 'string' && this.paths.get(id)
      if (!path || typeof id !== 'string' || !targetsFor(path).includes(target))
        throw new Error('Choose an available output format for the selected files.')
      return { id, path }
    })

    this.running = true
    const results: FileConversionResult[] = []
    try {
      for (const { id, path } of inputs) {
        if (!active()) break
        let result: FileConversionResult
        try {
          result = { id, ...(await saveConvertedFile(path, target, convert)) }
        } catch (error) {
          result = { id, error: error instanceof Error ? error.message : String(error) }
        }
        results.push(result)
        if (active()) progress(result)
      }
      return results
    } finally {
      this.running = false
    }
  }
}
