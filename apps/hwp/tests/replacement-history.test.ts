import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import init, { HwpDocument } from '@rhwp/core'
import { beforeAll, expect, it } from 'vitest'
import { captureReplacement } from '../studio-plugin/replacement-history.mjs'

beforeAll(async () => {
  const wasm = join(dirname(createRequire(import.meta.url).resolve('@rhwp/core')), 'rhwp_bg.wasm')
  await init({ module_or_path: readFileSync(wasm) })
})

it('restores every character run in one multilingual paragraph, including a non-BMP character', () => {
  const doc = HwpDocument.createEmpty()
  try {
    doc.createBlankDocument()
    const from = 'One 😀 passage',
      to = '하나의 😀 번역문'
    doc.insertText(0, 0, 0, from)
    doc.applyCharFormat(0, 0, 4, 5, JSON.stringify({ bold: true }))
    doc.applyCharFormat(0, 0, 6, 13, JSON.stringify({ italic: true }))
    const read = () => [
      doc.getTextRange(0, 0, 0, doc.getParagraphLength(0, 0)),
      doc.getCharShapeRuns(0, 0, 0, doc.getParagraphLength(0, 0)),
    ]
    const before = read()
    type Hit = { sec: number; para: number; charOffset: number; length: number }
    const hit: Hit = { sec: 0, para: 0, charOffset: 0, length: Array.from(from).length }
    function replace(d: HwpDocument, h: Hit, s: string) {
      d.replaceText(h.sec, h.para, h.charOffset, h.length, s)
    }
    const record = captureReplacement(doc, hit, null, false, replace)
    replace(doc, hit, to)
    record.finish()
    const after = read()
    expect(after[0]).toBe(to)
    for (let i = 0; i < 2; i++) {
      record.apply(true)
      expect(read()).toEqual(before)
      record.apply(false)
      expect(read()).toEqual(after)
    }
  } finally {
    doc.free()
  }
})
