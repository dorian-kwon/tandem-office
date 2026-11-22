import { it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { writeEditorOcr } from '../src/main/editor-ocr'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'editor-ocr-'))
  dirs.push(dir)
  const path = join(dir, 'report.docx')
  await writeFile(path, 'original')
  const opts = {
    readOnly: false,
    outputDir: dir,
    current: async () => true,
    recognize: async (_source: string, _format: string, output: string) => writeFile(output, 'OCR'),
  }
  return { dir, path, opts }
}
it('publishes unique copies and retains original bytes before replacing an editable file', async () => {
  const { path, dir, opts } = await setup()
  for (const suffix of ['', ' (2)']) {
    const result = await writeEditorOcr(path, { format: 'docx', apply: false }, opts)
    expect(basename(result.outputPath!)).toBe('report (OCR)' + suffix + '.docx')
    expect(await readFile(path, 'utf8')).toBe('original')
  }
  await writeEditorOcr(path, { format: 'docx', apply: true }, opts)
  expect(await readFile(join(dir, 'report (before OCR).docx'), 'utf8')).toBe('original')
  expect(await readFile(path, 'utf8')).toBe('OCR')
})
it('keeps an intervening edit and refuses replacing a read-only source', async () => {
  const { path, dir, opts } = await setup()
  const choice = { format: 'docx', apply: true }
  await expect(writeEditorOcr(path, choice, { ...opts, readOnly: true })).rejects.toThrow(
    'OCR_UNAVAILABLE',
  )
  await expect(
    writeEditorOcr(path, choice, {
      ...opts,
      recognize: async (source, format, out) => {
        await opts.recognize(source, format, out)
        await writeFile(source, 'manual edit')
      },
    }),
  ).rejects.toThrow('OCR_DOCUMENT_CHANGED')
  expect(await readFile(path, 'utf8')).toBe('manual edit')
  expect(await readdir(dir)).toEqual(['report.docx'])
})
