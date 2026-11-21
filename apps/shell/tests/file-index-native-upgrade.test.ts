import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { MessageChannel, Worker } from 'node:worker_threads'
import { resolveParseSidecarPath } from '@genoffice/file-parse/sidecar-path'
import { hostIndexParser } from '../src/main/file-index/native-parser'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it, vi } from 'vitest'
import { FileIndexer } from '../src/main/file-index/indexer'
import { FileIndexStore } from '../src/main/file-index/store'

// Model a previously capped file with a tiny valid document. The production
// worker still does the actual scan, extraction, tokenization and disk write.
vi.mock('../src/main/file-index/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/file-index/limits')>()),
  MAX_EXTRACT_BYTES: 1,
}))

it('fills a previously name-only DOCX and keeps an online-only copy unopened', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tandem-index-upgrade-'))
  const local = join(root, 'local.docx')
  const cloud = join(root, 'online.docx')
  const store = new FileIndexStore(join(root, 'index.db'))
  const indexer = new FileIndexer(store.dbPath, join(__dirname, 'file-index-real-worker.mjs'), {
    roots: () => [root],
    extraPaths: () => [],
    nameOnly: async () => new Set([cloud]),
  })
  try {
    const zip = new JSZip()
    zip.file(
      '_rels/.rels',
      '<Relationships><Relationship Id="d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    )
    zip.file(
      'word/document.xml',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>부산 관광 안내</w:t></w:r></w:p></w:body></w:document>',
    )
    const bytes = await zip.generateAsync({ type: 'nodebuffer' })
    for (const path of [local, cloud]) {
      writeFileSync(path, bytes)
      const stat = statSync(path)
      store.upsert(
        { path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size },
        null,
        path === cloud ? 'cloud' : 'name-only',
      )
    }
    await indexer.scan()
    expect(store.search('관광').hits.map((hit) => hit.path)).toEqual([local])
    expect(store.listAll().get(cloud)?.status).toBe('cloud')
  } finally {
    await indexer.stop()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('reaps the native child when its writer is abruptly terminated', async () => {
  const binary = resolveParseSidecarPath()
  expect(binary).toBeTruthy()
  const { port1, port2 } = new MessageChannel()
  const host = hostIndexParser(port1, binary)
  const worker = new Worker(
    String.raw`
    const { parentPort, workerData } = require('node:worker_threads')
    workerData.once('message', () => parentPort.postMessage('done'))
    workerData.postMessage(JSON.stringify({ version: 1, requestId: '1', command: 'tokenize_text', text: '부산' }) + '\n')
    parentPort.on('message', () => {})
  `,
    { eval: true, workerData: port2, transferList: [port2] },
  )
  try {
    await once(worker, 'message')
    const pid = host.pid()
    expect(pid).toBeTypeOf('number')
    await worker.terminate()
    // Closing the worker port is sufficient even if the writer itself crashed.
    await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 4000 })
  } finally {
    host.stop()
    await worker.terminate()
  }
})
