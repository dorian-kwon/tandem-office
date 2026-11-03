import JSZip from 'jszip'
import type { NoteInfo } from '@genoffice/docx-engine'
import { decodeEntities } from '@genoffice/docx-engine'
import type { NoteKind } from './note-ops'

/**
 * Keeps the run formatting of a translated note when the document is saved.
 *
 * The engine writes a changed note by patching its plain text into the entry's
 * w:t elements with a prefix/suffix diff: the first w:t the change touches
 * takes all the new text and the ones after it are emptied, so a note with an
 * italic title in the middle came back as one run. A translated note carries
 * its display runs (richParas) with the new text per run; this puts each run's
 * text back into the w:t that held that run, on the engine's output bytes.
 * It only acts where the saved paragraph has exactly one w:t per display run
 * and the paragraph's text stays the same afterwards; anything else keeps the
 * engine's result.
 */

const PART: Record<NoteKind, { path: string; entry: string }> = {
  footnote: { path: 'word/footnotes.xml', entry: 'w:footnote' },
  endnote: { path: 'word/endnotes.xml', entry: 'w:endnote' },
}

const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

interface TSlice {
  start: number
  end: number
  text: string
}

function slicesOf(xml: string, re: RegExp): Array<{ start: number; end: number; xml: string }> {
  const out: Array<{ start: number; end: number; xml: string }> = []
  for (const m of xml.matchAll(re))
    out.push({ start: m.index!, end: m.index! + m[0].length, xml: m[0] })
  return out
}

const T_RE = /<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g

function tSlices(paraXml: string): TSlice[] {
  return slicesOf(paraXml, T_RE).map((m) => ({
    start: m.start,
    end: m.end,
    text: decodeEntities(m.xml.replace(/^<w:t(?:\s[^>]*)?>/, '').replace(/<\/w:t>$/, '')),
  }))
}

/**
 * The display runs of one paragraph are the reader's merge of adjacent w:t
 * elements of equal formatting, so a run may span several w:t. The w:t
 * elements of the ORIGINAL paragraph are grouped by the lengths of the
 * original runs; the new text of a run goes into the first w:t of its group
 * and the others in it are emptied. Null when the groups do not line up.
 */
function patchParagraph(
  savedXml: string,
  originalXml: string,
  oldRuns: string[],
  newRuns: string[],
  first: boolean,
): string | null {
  if (savedXml.includes('txbxContent') || oldRuns.length !== newRuns.length) return null
  const saved = tSlices(savedXml)
  const original = tSlices(originalXml)
  if (saved.length !== original.length) return null
  // the first paragraph opens with the reference mark and a spacer the runs do not carry
  let lead = ''
  let skip = 0
  if (first && original.length > 0) {
    lead = /^\s*/.exec(original[0].text)![0]
    if (lead.length === original[0].text.length) {
      skip = 1
      lead = ''
    }
  }
  const groups: number[][] = []
  let at = skip
  let consumed = lead.length // whitespace of a merged spacer: not part of the first run
  for (const run of oldRuns) {
    const group: number[] = []
    let sum = 0
    while (at < original.length && sum < run.length) {
      const text = original[at].text.slice(group.length === 0 && at === skip ? consumed : 0)
      sum += text.length
      group.push(at++)
    }
    if (sum !== run.length || group.length === 0) return null
    groups.push(group)
    consumed = 0
  }
  const target = new Map<number, string>()
  groups.forEach((group, j) => {
    group.forEach((index, k) => {
      const keep = j === 0 && k === 0 && skip === 0 ? lead : ''
      target.set(index, k === 0 ? keep + newRuns[j] : '')
    })
  })
  const before = saved.map((t) => t.text).join('')
  let out = ''
  let cursor = 0
  const after: string[] = []
  saved.forEach((t, i) => {
    const text = target.has(i) ? target.get(i)! : t.text
    after.push(text)
    out +=
      savedXml.slice(cursor, t.start) +
      (target.has(i)
        ? `<w:t xml:space="preserve">${escapeText(text)}</w:t>`
        : savedXml.slice(t.start, t.end))
    cursor = t.end
  })
  out += savedXml.slice(cursor)
  return after.join('') === before ? out : null
}

function patchEntry(
  savedXml: string,
  originalXml: string,
  before: NoteInfo,
  note: NoteInfo,
): string | null {
  const paras = slicesOf(savedXml, /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
  const originals = slicesOf(originalXml, /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)
  const oldRich = before.richParas
  const newRich = note.richParas
  if (!oldRich || !newRich || paras.length !== newRich.length || originals.length !== paras.length)
    return null
  if (oldRich.length !== newRich.length) return null
  if ([...oldRich, ...newRich].some((runs) => runs.some((r) => r.del))) return null
  let out = ''
  let cursor = 0
  for (let i = 0; i < paras.length; i++) {
    const patched = patchParagraph(
      paras[i].xml,
      originals[i].xml,
      oldRich[i].map((r) => r.text),
      newRich[i].map((r) => r.text),
      i === 0 && !note.noRefMark,
    )
    if (patched === null) return null
    out += savedXml.slice(cursor, paras[i].start) + patched
    cursor = paras[i].end
  }
  return out + savedXml.slice(cursor)
}

/**
 * `bytes` is the engine's saved docx, `originalBytes` the document as opened,
 * `original` the notes as opened. Returns the same bytes when no changed note
 * needs the repair.
 */
export async function restoreNoteRuns(
  bytes: Uint8Array,
  originalBytes: Uint8Array,
  original: Record<NoteKind, readonly NoteInfo[]>,
  current: Record<NoteKind, readonly NoteInfo[]>,
): Promise<Uint8Array> {
  const changed = (kind: NoteKind) =>
    current[kind].filter((note) => {
      const before = original[kind].find((n) => n.id === note.id)
      return !!before && !!note.richParas && before.text !== note.text
    })
  if (changed('footnote').length === 0 && changed('endnote').length === 0) return bytes
  const zip = await JSZip.loadAsync(bytes)
  const originalZip = await JSZip.loadAsync(originalBytes)
  let touched = false
  const entryOf = (xml: string, entry: string, id: string) =>
    slicesOf(xml, new RegExp(`<${entry}(\\s[^>]*[^/>])?>[\\s\\S]*?</${entry}>`, 'g')).find((s) => {
      const attrs = /^<[^\s>]+(\s[^>]*)?>/.exec(s.xml)?.[1] ?? ''
      return !/w:type=/.test(attrs) && new RegExp(`w:id=(?:"${id}"|'${id}')`).test(attrs)
    })
  for (const kind of ['footnote', 'endnote'] as const) {
    const notes = changed(kind)
    const file = zip.file(PART[kind].path)
    const originalFile = originalZip.file(PART[kind].path)
    if (notes.length === 0 || !file || !originalFile) continue
    let xml = await file.async('string')
    const originalXml = await originalFile.async('string')
    const { entry } = PART[kind]
    for (const note of notes) {
      const hit = entryOf(xml, entry, note.id)
      const was = entryOf(originalXml, entry, note.id)
      const before = original[kind].find((n) => n.id === note.id)
      if (!hit || !was || !before) continue
      const patched = patchEntry(hit.xml, was.xml, before, note)
      if (patched === null || patched === hit.xml) continue
      xml = xml.slice(0, hit.start) + patched + xml.slice(hit.end)
      touched = true
    }
    zip.file(PART[kind].path, xml)
  }
  if (!touched) return bytes
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
