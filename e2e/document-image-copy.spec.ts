import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication } from '@playwright/test'
import JSZip from 'jszip'
import { jpegSize } from '../packages/pptx-render/src/image-dpi'
import { closeAndSaveVideo, launchShell, waitForPageWithUrl } from './helpers'

const WIDTH = 2800
const HEIGHT = 2800
const TITLE = 'Reduce document image size'
const BODY = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Image copy fixture</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="2743200" cy="2743200"/><wp:docPr id="1" name="Noise image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Noise image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="image1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2743200" cy="2743200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`

/** A real BMP whose ZIP size also exceeds preflight's 20 MiB file threshold. */
async function createFixture(path: string): Promise<void> {
  const pixels = WIDTH * HEIGHT * 3 // Width is divisible by four: no row padding.
  const bmp = Buffer.alloc(54 + pixels)
  bmp.write('BM')
  bmp.writeUInt32LE(bmp.length, 2)
  bmp.writeUInt32LE(54, 10)
  bmp.writeUInt32LE(40, 14)
  bmp.writeInt32LE(WIDTH, 18)
  bmp.writeInt32LE(HEIGHT, 22)
  bmp.writeUInt16LE(1, 26)
  bmp.writeUInt16LE(24, 28)
  bmp.writeUInt32LE(pixels, 34)
  let seed = 0x6d2b79f5
  for (let offset = 54; offset < bmp.length; offset++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    bmp[offset] = seed & 255
  }
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/noise.bmp"/></Relationships>',
  )
  zip.file('word/document.xml', BODY)
  zip.file('word/media/noise.bmp', bmp)
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  expect((await stat(path)).size).toBeGreaterThan(20 * 1024 ** 2)
}

interface Probe {
  messages: Array<{ message: string; buttons?: string[]; defaultId?: number; cancelId?: number }>
  saveCalls: number
  directory: string | null
  converterExited: boolean
  release?: () => void
}

async function openWithChoice(
  app: ElectronApplication,
  input: string,
  target: string,
  choice: number,
) {
  await app.evaluate(
    ({ dialog, Menu, utilityProcess }, args) => {
      const state: Probe = { messages: [], saveCalls: 0, directory: null, converterExited: false }
      ;(globalThis as unknown as { imageCopyProbe: Probe }).imageCopyProbe = state
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [args.input],
      })) as typeof dialog.showOpenDialog
      dialog.showSaveDialog = (async () => {
        state.saveCalls++
        return { canceled: false, filePath: args.target }
      }) as typeof dialog.showSaveDialog
      dialog.showMessageBox = (async (...params: unknown[]) => {
        const options = params.at(-1) as Electron.MessageBoxOptions
        state.messages.push({
          message: options.message,
          buttons: options.buttons,
          defaultId: options.defaultId,
          cancelId: options.cancelId,
        })
        return {
          response: options.buttons?.includes('Make JPEG copy') ? args.choice : 0,
          checkboxChecked: false,
        }
      }) as typeof dialog.showMessageBox

      // Hold only delivery of the conversion job until the progress UI is observed.
      // The worker, BMP decoding, native JPEG encoding and cancellation remain real.
      const fork = utilityProcess.fork.bind(utilityProcess)
      utilityProcess.fork = (...params) => {
        const child = fork(...params)
        if (params[2]?.serviceName !== 'document-image-copy') return child
        const send = child.postMessage.bind(child)
        child.postMessage = (message, transfer) => {
          if (message?.type === 'run' && message.mode === 'convert') {
            state.directory = message.directory
            state.release = () => send(message, transfer)
            child.once('exit', () => {
              state.converterExited = true
            })
          } else send(message, transfer)
        }
        return child
      }
      const open = Menu.getApplicationMenu()
        ?.items.flatMap((item) => item.submenu?.items ?? [])
        .find((item) => item.accelerator === 'CmdOrCtrl+O')
      if (!open) throw new Error('File Open menu is unavailable')
      open.click()
    },
    { input, target, choice },
  )
}

async function probe(app: ElectronApplication) {
  return app.evaluate(() => {
    const { release: _release, ...data } = (globalThis as unknown as { imageCopyProbe: Probe })
      .imageCopyProbe
    return data
  })
}

async function hash(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

test.describe('large BMP document copies through File Open', () => {
  let directory: string
  let original: string
  let originalHash: string
  test.beforeAll(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'tandem-image-copy-e2e-')))
    original = join(directory, 'original.docx')
    await createFixture(original)
    originalHash = await hash(original)
  })
  test.afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  for (const action of [
    'original',
    'prompt cancel',
    'existing destination',
    'progress cancel',
    'quit',
    'copy',
  ] as const) {
    test(action, async () => {
      test.setTimeout(150_000)
      const launched = await launchShell({
        onboardingSeen: true,
        videoDir: `image-copy-${action.replaceAll(' ', '-')}`,
      })
      const { app } = launched
      let closed = false
      app.once('close', () => {
        closed = true
      })
      const target =
        action === 'existing destination' ? original : join(directory, `copy-${action}.docx`)
      const documentPaths = () =>
        launched.page.evaluate(async () => {
          const tabs = await (
            window as unknown as {
              aiOfficeTabs: { list(): Promise<Array<{ filePath?: string }>> }
            }
          ).aiOfficeTabs.list()
          return tabs.map((tab) => tab.filePath).filter(Boolean)
        })
      try {
        await openWithChoice(
          app,
          original,
          target,
          action === 'original' ? 1 : action === 'prompt cancel' ? 2 : 0,
        )
        await expect.poll(async () => (await probe(app)).messages.length).toBeGreaterThanOrEqual(1)
        expect((await probe(app)).messages[0]).toMatchObject({
          message: expect.stringMatching(/^BMP images: 1, [\d.]+ MB$/),
          buttons: ['Make JPEG copy', 'Open original', 'Cancel'],
          defaultId: 1,
          cancelId: 2,
        })
        if (action === 'original') {
          const editor = await waitForPageWithUrl(app, '://docs/')
          await expect(editor.locator('.doc-page').first()).toContainText('Image copy fixture')
          expect(await documentPaths()).toEqual([original])
          expect((await probe(app)).saveCalls).toBe(0)
        } else if (action === 'prompt cancel') {
          expect((await probe(app)).saveCalls).toBe(0)
          expect(app.windows().some((page) => page.url().includes('://docs/'))).toBe(false)
          expect(await documentPaths()).toEqual([])
        } else if (action === 'existing destination') {
          await expect.poll(async () => (await probe(app)).messages.length).toBe(2)
          expect((await probe(app)).messages[1].message).toContain('The copy could not be created')
          expect((await probe(app)).directory).toBeNull()
          await expect.poll(documentPaths).toEqual([original])
        } else {
          await expect.poll(async () => (await probe(app)).directory).not.toBeNull()
          await expect
            .poll(() => app.windows().some((page) => page.url().startsWith('data:text/html')))
            .toBe(true)
          const progress = app.windows().find((page) => page.url().startsWith('data:text/html'))!
          await expect(progress).toHaveTitle(TITLE)
          await expect(progress.getByText('Creating a smaller copy…')).toBeVisible()
          if (action === 'progress cancel') {
            await progress.getByRole('button', { name: 'Cancel', exact: true }).click()
            await expect.poll(async () => (await probe(app)).converterExited).toBe(true)
            const spool = (await probe(app)).directory!
            await expect.poll(() => existsSync(spool)).toBe(false)
            expect(app.windows().some((page) => page.url().includes('://docs/'))).toBe(false)
            expect(await documentPaths()).toEqual([])
            expect((await probe(app)).messages).toHaveLength(1)
          } else if (action === 'quit') {
            const spool = (await probe(app)).directory!
            const exited = app.waitForEvent('close')
            await app
              .evaluate(({ app }) => {
                setImmediate(() => app.quit())
              })
              .catch(() => {})
            await exited
            expect(existsSync(spool)).toBe(false)
          } else {
            await app.evaluate(() =>
              (globalThis as unknown as { imageCopyProbe: Probe }).imageCopyProbe.release!(),
            )
            await expect
              .poll(
                async () => ({
                  published: existsSync(target),
                  messages: (await probe(app)).messages,
                }),
                { timeout: 60_000 },
              )
              .toMatchObject({ published: true })
            await expect.poll(async () => (await probe(app)).messages.length).toBe(2)
            expect((await probe(app)).messages[1].message).toMatch(/converted 1, unchanged 0$/)
            const editor = await waitForPageWithUrl(app, '://docs/')
            await expect(editor.locator('.doc-page').first()).toContainText('Image copy fixture')
            expect(await documentPaths()).toEqual([target])
            expect((await stat(target)).size).toBeLessThan((await stat(original)).size)
            const zip = await JSZip.loadAsync(await readFile(target))
            expect(await zip.file('word/document.xml')!.async('string')).toBe(BODY)
            expect(zip.file('word/media/noise.bmp')).toBeNull()
            expect(jpegSize(await zip.file('word/media/noise.jpg')!.async('nodebuffer'))).toEqual({
              w: WIDTH,
              h: HEIGHT,
            })
            expect(await zip.file('word/_rels/document.xml.rels')!.async('string')).toContain(
              'media/noise.jpg',
            )
            await expect.poll(() => progress.isClosed()).toBe(true)
            const spool = (await probe(app)).directory!
            await expect.poll(() => existsSync(spool)).toBe(false)
          }
        }
        expect(await hash(original)).toBe(originalHash)
        if (action !== 'copy' && action !== 'existing destination')
          expect(existsSync(target)).toBe(false)
      } finally {
        if (!closed) await closeAndSaveVideo(launched, `image-copy-${action.replaceAll(' ', '-')}`)
      }
    })
  }
})
