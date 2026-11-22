import { chmod, lstat, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { recompressPdfImages } from '../../../../apps/pdf/src/main/pdf-shrink'
import { optimizeZipImageParts } from '../../../../apps/shell/src/main/document-images/zip'
import { recompressPng } from '../../../pdf2docx/src/extract/png'
import { assertPackageWithinLimits } from '../limits'

const zipTypes = new Set(['docx', 'xlsx', 'pptx', 'hwpx', 'odt', 'ods', 'odp', 'epub', 'xmind'])
const maxDecodedImage = 32 * 1024 * 1024

/** Runs only on the completed conversion output. Leave the usable first result
 * in place if a codec is unsupported, disk space runs out, or its size grows. */
export async function optimizeConvertedImages(
  path: string,
  extension: string,
): Promise<{
  images: number
  bytesSaved: number
}> {
  const unchanged = { images: 0, bytesSaved: 0 }
  if (!zipTypes.has(extension) && extension !== 'pdf') return unchanged
  let scratch: string | undefined
  try {
    const before = await lstat(path, { bigint: true })
    if (!before.isFile() || before.size < 4096n) return unchanged
    // pdf-lib needs the whole PDF in memory. ZIP containers are copied in chunks.
    if (extension === 'pdf' && before.size > 96n * 1024n * 1024n) return unchanged
    scratch = await mkdtemp(join(dirname(path), '.tandem-shrink-'))
    const output = join(scratch, 'result.' + extension)
    let images: number
    if (extension === 'pdf') {
      const bytes = await readFile(path)
      if (bytes.includes(Buffer.from('/ByteRange'))) return unchanged
      const doc = await PDFDocument.load(bytes, { updateMetadata: false })
      if (doc.isEncrypted) return unchanged
      images = recompressPdfImages(doc, maxDecodedImage)
      if (!images) return unchanged
      await writeFile(output, await doc.save({ updateFieldAppearances: false }), {
        flag: 'wx',
        mode: 0o600,
      })
    } else {
      images = await optimizeZipImageParts(path, output, scratch, (bytes) =>
        recompressPng(bytes, maxDecodedImage),
      )
      if (!images) return unchanged
      // Highly compressible data must still open under the CLI's own ZIP limits.
      assertPackageWithinLimits(output, extension)
    }
    const after = await lstat(output, { bigint: true })
    if (after.size >= before.size) return unchanged
    await chmod(output, Number(before.mode & 0o777n))
    const live = await lstat(path, { bigint: true })
    if (live.dev !== before.dev || live.ino !== before.ino || live.ctimeNs !== before.ctimeNs)
      return unchanged
    await rename(output, path)
    return { images, bytesSaved: Number(before.size - after.size) }
  } catch {
    return unchanged
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}
