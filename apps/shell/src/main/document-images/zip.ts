import { constants } from 'node:fs'
import { lstat, mkdtemp, open, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import { XMLValidator } from 'fast-xml-parser'
import { readZipEntries, type ByteSource, type ZipEntry } from '@genoffice/docx-engine/zip-splice'

export type ZipDocumentKind = 'docx' | 'xlsx' | 'pptx' | 'hwpx'
const MAX_BMP = 192 * 1024 * 1024
const MAX_XML = 8 * 1024 * 1024
const MAX_XML_TOTAL = 32 * 1024 * 1024
const CHUNK = 256 * 1024
const hasControls = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const OPF_NS = 'http://www.idpf.org/2007/opf'
const MANIFEST_NS = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'
const BMP_MIMES = new Set(['image/bmp', 'image/x-bmp', 'image/x-ms-bmp'])
const MAIN_PART = {
  docx: 'word/document.xml',
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
  hwpx: 'Contents/content.hpf',
}
const unsupported = () => new Error('Unsupported or ambiguous ZIP document')
const signature = (s: {
  dev: number
  ino: number
  size: number
  mtimeMs: number
  ctimeMs: number
}) => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':')
const checkAbort = (signal?: AbortSignal) => {
  signal?.throwIfAborted()
}

interface Source extends ByteSource {
  handle: FileHandle
  entries: ZipEntry[]
  byName: Map<string, ZipEntry>
  identity: string
  inputPath: string
}

/** Keep the source open throughout conversion; no whole-archive Buffer or extracted paths. */
async function source(inputPath: string): Promise<Source> {
  const handle = await open(inputPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size < 22) throw unsupported()
    const bytes: ByteSource = {
      size: stat.size,
      async read(offset, length) {
        if (
          !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) ||
          offset < 0 ||
          length < 0 ||
          length > MAX_BMP ||
          length > stat.size - offset
        )
          throw unsupported()
        const result = Buffer.alloc(length)
        let done = 0
        while (done < length) {
          const read = await handle.read(result, done, length - done, offset + done)
          if (!read.bytesRead) throw unsupported()
          done += read.bytesRead
        }
        return result
      },
    }
    const tail = await bytes.read(Math.max(0, stat.size - 65557), Math.min(stat.size, 65557))
    let end = tail.length - 22
    while (end >= 0 && tail.readUInt32LE(end) !== 0x06054b50) end--
    if (
      end < 0 ||
      tail.readUInt16LE(end + 4) !== 0 ||
      tail.readUInt16LE(end + 6) !== 0 ||
      tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10) ||
      tail.readUInt32LE(end + 12) > 16 * 1024 * 1024 ||
      end + 22 + tail.readUInt16LE(end + 20) !== tail.length
    )
      throw unsupported()
    // Bound the directory allocation before the shared reader sees it.
    // The reader then bounds part counts, declared inflation and compressed ranges.
    const entries = await readZipEntries(bytes)
    const centralStart = tail.readUInt32LE(end + 16)
    const byName = new Map<string, ZipEntry>(),
      insensitive = new Set<string>()
    const ranges: Array<[number, number]> = []
    for (const entry of entries) {
      const name = entry.name
      if (
        !name ||
        name.startsWith('/') ||
        name.includes('\\') ||
        hasControls(name) ||
        name
          .replace(/\/$/, '')
          .split('/')
          .some((p) => !p || p === '.' || p === '..') ||
        name.includes(':')
      )
        throw unsupported()
      if (entry.flags & 0x800) new TextDecoder('utf-8', { fatal: true }).decode(entry.nameBytes)
      else if (entry.nameBytes.some((b) => b > 127)) throw unsupported()
      const key = name.replace(/\/$/, '').toLowerCase()
      if (insensitive.has(key) || byName.has(name)) throw unsupported()
      insensitive.add(key)
      byName.set(name, entry)
      if (
        /(?:^|\/)(?:_xmlsignatures|signatures?|digital-signatures?)(?:\/|\.|$)/i.test(name) ||
        /(?:^|\/)META-INF\/encryption\.xml$/i.test(name)
      )
        throw unsupported()
      if (entry.dataOffset + entry.csize > centralStart || ![0, 8].includes(entry.method))
        throw unsupported()
      // Reject central/local disagreement instead of rewriting an ambiguous package.
      // Find the local header using the central directory offset retained by an independent walk below.
    }
    const centralSize = tail.readUInt32LE(end + 12)
    const central = await bytes.read(centralStart, centralSize)
    let cursor = 0
    for (const entry of entries) {
      if (central.readUInt16LE(cursor + 34) !== 0) throw unsupported()
      const localOffset = central.readUInt32LE(cursor + 42)
      const local = await bytes.read(localOffset, 30)
      const nameLength = local.readUInt16LE(26),
        extraLength = local.readUInt16LE(28)
      if (
        local.readUInt16LE(6) !== entry.flags ||
        local.readUInt16LE(8) !== entry.method ||
        !(await bytes.read(localOffset + 30, nameLength)).equals(entry.nameBytes)
      )
        throw unsupported()
      if (
        !(entry.flags & 8) &&
        (local.readUInt32LE(14) !== entry.crc ||
          local.readUInt32LE(18) !== entry.csize ||
          local.readUInt32LE(22) !== entry.usize)
      )
        throw unsupported()
      const extra = await bytes.read(localOffset + 30 + nameLength, extraLength)
      // Unicode-path extra fields can make readers disagree with the package part name.
      for (let p = 0; p < extra.length;) {
        if (p + 4 > extra.length) throw unsupported()
        const id = extra.readUInt16LE(p),
          length = extra.readUInt16LE(p + 2)
        if (p + 4 + length > extra.length || id === 0x7075 || id === 0x0001) throw unsupported()
        p += 4 + length
      }
      const centralName = central.readUInt16LE(cursor + 28),
        centralExtra = central.readUInt16LE(cursor + 30),
        comment = central.readUInt16LE(cursor + 32)
      for (let p = cursor + 46 + centralName, stop = p + centralExtra; p < stop;) {
        if (p + 4 > stop) throw unsupported()
        const id = central.readUInt16LE(p),
          length = central.readUInt16LE(p + 2)
        if (p + 4 + length > stop || id === 0x7075 || id === 0x0001) throw unsupported()
        p += 4 + length
      }
      ranges.push([localOffset, entry.dataOffset + entry.csize])
      cursor += 46 + centralName + centralExtra + comment
    }
    ranges.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i]![0] < ranges[i - 1]![1]) throw unsupported()
    if (cursor !== central.length) throw unsupported()
    return { ...bytes, handle, entries, byName, identity: signature(stat), inputPath }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function unchanged(src: Source) {
  if (
    signature(await src.handle.stat()) !== src.identity ||
    signature(await lstat(src.inputPath)) !== src.identity
  )
    throw new Error('Source document changed during conversion')
}

async function part(src: Source, entry: ZipEntry, cap: number): Promise<Buffer> {
  if (entry.usize > cap || entry.csize > cap) throw unsupported()
  const compressed = await src.read(entry.dataOffset, entry.csize)
  const data =
    entry.method === 0
      ? compressed
      : inflateRawSync(compressed, { maxOutputLength: Math.min(cap, entry.usize) + 1 })
  if (data.length !== entry.usize || crc32(data) !== entry.crc) throw unsupported()
  return data
}

interface Attr {
  value: string
  start: number
  end: number
}
interface Tag {
  name: string
  local: string
  ns: string
  attrs: Map<string, Attr>
  namespaces: Map<string, string>
  start: number
  end: number
  parent?: Tag
}
interface Xml {
  text: string
  tags: Tag[]
  root: Tag
  close: number
}
interface Patch {
  start: number
  end: number
  value: string
}
function entities(value: string): string {
  return value.replace(/&([^;]*);/g, (_, entity: string) => {
    if (/^#(?:x[\da-fA-F]+|\d+)$/.test(entity)) {
      const point = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      if (
        !Number.isInteger(point) ||
        point <= 0 ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        throw unsupported()
      return String.fromCodePoint(point)
    }
    const decoded = (
      { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>
    )[entity]
    if (decoded === undefined) throw unsupported()
    return decoded
  })
}
const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
const encodePath = (s: string) =>
  s
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/')

/** Validate metadata XML, but patch attribute spans to preserve everything unrelated verbatim. */
function parseXml(bytes: Buffer): Xml {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (
    /<!DOCTYPE|<!ENTITY/i.test(text) ||
    /<\?xml[^>]*encoding\s*=\s*["'](?!utf-8["'])/i.test(text) ||
    XMLValidator.validate(text) !== true
  )
    throw unsupported()
  const tags: Tag[] = [],
    stack: Array<{ tag: Tag; namespaces: Map<string, string> }> = []
  let close = -1
  for (const m of text.matchAll(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:"[^"]*"|'[^']*'|[^'">])*>/g,
  )) {
    const raw = m[0],
      start = m.index!
    if (raw.startsWith('<!') || raw.startsWith('<?')) continue
    if (raw.startsWith('</')) {
      if (stack.length === 1) close = start
      stack.pop()
      continue
    }
    const name = /^<([^\s/>]+)/.exec(raw)![1]!,
      attrs = new Map<string, Attr>()
    const namespaces = new Map(stack.at(-1)?.namespaces ?? [])
    for (const a of raw.matchAll(/([^\s=<>"'/]+)\s*=\s*(["'])([\s\S]*?)\2/g)) {
      const at = start + a.index! + a[0].indexOf(a[2]!) + 1,
        value = entities(a[3]!)
      if (attrs.has(a[1]!)) throw unsupported()
      attrs.set(a[1]!, { value, start: at, end: at + a[3]!.length })
      if (a[1] === 'xmlns') namespaces.set('', value)
      else if (a[1]!.startsWith('xmlns:')) namespaces.set(a[1]!.slice(6), value)
    }
    const colon = name.indexOf(':'),
      prefix = colon < 0 ? '' : name.slice(0, colon)
    const tag: Tag = {
      name,
      local: colon < 0 ? name : name.slice(colon + 1),
      ns: namespaces.get(prefix) ?? '',
      attrs,
      namespaces,
      start,
      end: start + raw.length,
      parent: stack.at(-1)?.tag,
    }
    tags.push(tag)
    if (!raw.endsWith('/>')) stack.push({ tag, namespaces })
  }
  if (!tags[0] || (close < 0 && !text.slice(tags[0].start, tags[0].end).endsWith('/>')))
    throw unsupported()
  return { text, tags, root: tags[0], close }
}
const valueOf = (tag: Tag, name: string): string => tag.attrs.get(name)?.value ?? ''
function pathOf(base: string, value: string): string {
  const decoded = decodeURIComponent(value)
  if (
    !decoded ||
    /[\\?#]/.test(decoded) ||
    hasControls(decoded) ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded) ||
    decoded.startsWith('//')
  )
    throw unsupported()
  const path = posix.normalize(
    decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded),
  )
  if (path === '..' || path.startsWith('../') || path.startsWith('/')) throw unsupported()
  return path
}
interface Reference {
  xml: string
  attr: Attr
  base: string
  absolute: boolean
  mime?: Attr
}
interface Candidate {
  entry: ZipEntry
  refs: Reference[]
  override?: Tag
}
interface Package {
  xml: Map<string, Xml>
  candidates: Candidate[]
  contentTypes?: Xml
  reservedNames: Set<string>
}

function reserveName(taken: Set<string>, name: string): void {
  let path = name.replace(/\/$/, '').toLowerCase()
  while (path && path !== '.') {
    taken.add(path)
    path = posix.dirname(path)
  }
}

function manifestAttr(tag: Tag, local: string): Attr {
  const matches = [...tag.attrs].filter(([name]) => {
    const colon = name.indexOf(':')
    return colon < 0
      ? name === local
      : name.slice(colon + 1) === local && tag.namespaces.get(name.slice(0, colon)) === MANIFEST_NS
  })
  if (matches.length !== 1) throw unsupported()
  return matches[0]![1]
}

async function inspect(src: Source, kind: ZipDocumentKind): Promise<Package> {
  if (!src.byName.has(MAIN_PART[kind])) throw unsupported()
  const xml = new Map<string, Xml>()
  let xmlBytes = 0
  const load = async (name: string) => {
    const entry = src.byName.get(name)
    if (!entry) throw unsupported()
    xmlBytes += entry.usize
    if (xmlBytes > MAX_XML_TOTAL) throw unsupported()
    const parsed = parseXml(await part(src, entry, MAX_XML))
    xml.set(name, parsed)
    return parsed
  }
  const candidates = new Map<string, Candidate>()
  const reservedNames = new Set<string>()
  for (const entry of src.entries) reserveName(reservedNames, entry.name)
  if (kind === 'hwpx') {
    const manifest = await load('Contents/content.hpf'),
      ids = new Set<string>()
    if (manifest.root.local !== 'package' || manifest.root.ns.replace(/\/$/, '') !== OPF_NS)
      throw unsupported()
    const items: Array<{
      tag: Tag
      direct: string | null
      names: string[]
      mime: string
      embedded: boolean
    }> = []
    for (const tag of manifest.tags.filter(
      (t) =>
        t.local === 'item' &&
        t.ns.replace(/\/$/, '') === OPF_NS &&
        t.parent?.local === 'manifest' &&
        t.parent.ns.replace(/\/$/, '') === OPF_NS,
    )) {
      const id = valueOf(tag, 'id'),
        href = valueOf(tag, 'href'),
        mime = valueOf(tag, 'media-type').toLowerCase()
      if (!id || ids.has(id)) throw unsupported()
      ids.add(id)
      const resolveFrom = (base: string): string | null => {
        try {
          return pathOf(base, href)
        } catch {
          return null
        }
      }
      const direct = resolveFrom(''),
        relative = resolveFrom('Contents')
      for (const name of [direct, relative]) if (name) reserveName(reservedNames, name)
      const names = [
        ...new Set(
          [direct, relative].filter(
            (name): name is string => name !== null && src.byName.has(name),
          ),
        ),
      ]
      const embedded = valueOf(tag, 'isEmbeded') !== '0'
      items.push({ tag, direct, names, mime, embedded })
      if (!BMP_MIMES.has(mime) || !embedded) continue
      if (names.length !== 1) throw unsupported()
      const name = names[0]!
      candidates.set(name, candidates.get(name) ?? { entry: src.byName.get(name)!, refs: [] })
    }
    // An alias with another declared format must not be silently left pointing
    // to the renamed asset, irrespective of manifest item order.
    for (const item of items) {
      for (const name of item.names) {
        const candidate = candidates.get(name)
        if (!candidate) continue
        if (item.names.length !== 1 || !item.embedded || !BMP_MIMES.has(item.mime))
          throw unsupported()
        const href = valueOf(item.tag, 'href')
        candidate.refs.push({
          xml: 'Contents/content.hpf',
          attr: item.tag.attrs.get('href')!,
          base: name === item.direct ? '' : 'Contents',
          absolute: href.startsWith('/'),
          mime: item.tag.attrs.get('media-type')!,
        })
      }
    }
    if (src.byName.has('META-INF/manifest.xml')) {
      const metadata = await load('META-INF/manifest.xml')
      if (metadata.root.local !== 'manifest' || metadata.root.ns !== MANIFEST_NS)
        throw unsupported()
      const names = new Set<string>()
      for (const tag of metadata.tags) {
        if (tag.ns !== MANIFEST_NS) continue
        if (tag.local === 'encryption-data') throw unsupported()
        if (tag.local !== 'file-entry' || tag.parent !== metadata.root) continue
        const path = manifestAttr(tag, 'full-path'),
          mime = manifestAttr(tag, 'media-type')
        if (path.value === '/') continue
        const name = pathOf('', path.value)
        if (names.has(name)) throw unsupported()
        names.add(name)
        reserveName(reservedNames, name)
        const candidate = candidates.get(name)
        if (!candidate) continue
        if (!BMP_MIMES.has(mime.value.toLowerCase())) throw unsupported()
        candidate.refs.push({
          xml: 'META-INF/manifest.xml',
          attr: path,
          base: '',
          absolute: path.value.startsWith('/'),
          mime,
        })
      }
    }
    return { xml, candidates: [...candidates.values()], reservedNames }
  }
  const contentTypes = await load('[Content_Types].xml')
  if (contentTypes.root.local !== 'Types' || contentTypes.root.ns !== CT_NS) throw unsupported()
  const defaults = new Map<string, string>(),
    overrides = new Map<string, Tag>()
  for (const tag of contentTypes.tags.filter(
    (t) => t.parent === contentTypes.root && t.ns === CT_NS,
  )) {
    const mime = valueOf(tag, 'ContentType')
    if (/digital-signature|encrypted/i.test(mime)) throw unsupported()
    if (tag.local === 'Default') {
      const extension = valueOf(tag, 'Extension').toLowerCase()
      if (!extension || defaults.has(extension)) throw unsupported()
      defaults.set(extension, mime)
    } else if (tag.local === 'Override') {
      const name = pathOf('', valueOf(tag, 'PartName'))
      if (overrides.has(name)) throw unsupported()
      overrides.set(name, tag)
      reserveName(reservedNames, name)
    }
  }
  for (const entry of src.entries) {
    const override = overrides.get(entry.name),
      mime = override
        ? valueOf(override, 'ContentType')
        : defaults.get(posix.extname(entry.name).slice(1).toLowerCase())
    if (BMP_MIMES.has(mime?.toLowerCase() ?? '') && !entry.name.endsWith('/'))
      candidates.set(entry.name, { entry, refs: [], override })
  }
  for (const entry of src.entries) {
    if (!/(?:^|\/)_rels\/[^/]*\.rels$/.test(entry.name)) continue
    const rels = await load(entry.name)
    if (rels.root.local !== 'Relationships' || rels.root.ns !== REL_NS) throw unsupported()
    const base =
      entry.name === '_rels/.rels' ? '' : posix.dirname(entry.name).replace(/(?:^|\/)_rels$/, '')
    const ids = new Set<string>()
    for (const tag of rels.tags.filter(
      (t) => t.parent === rels.root && t.ns === REL_NS && t.local === 'Relationship',
    )) {
      const id = valueOf(tag, 'Id'),
        type = valueOf(tag, 'Type'),
        mode = valueOf(tag, 'TargetMode')
      if (!id || ids.has(id) || /digital-signature/i.test(type)) throw unsupported()
      ids.add(id)
      if (mode === 'External') continue
      if (mode && mode !== 'Internal') throw unsupported()
      const target = valueOf(tag, 'Target'),
        candidate = candidates.get(pathOf(base, target))
      if (!candidate) continue
      if (
        !/^http:\/\/(?:schemas\.openxmlformats\.org\/officeDocument\/2006|purl\.oclc\.org\/ooxml\/officeDocument)\/relationships\/image$/.test(
          type,
        )
      )
        throw unsupported()
      candidate.refs.push({
        xml: entry.name,
        attr: tag.attrs.get('Target')!,
        base,
        absolute: target.startsWith('/'),
      })
    }
  }
  return {
    xml,
    contentTypes,
    reservedNames,
    candidates: [...candidates.values()].filter((c) => c.refs.length > 0),
  }
}

export async function inspectZipBmp(
  inputPath: string,
  kind: ZipDocumentKind,
): Promise<{ count: number; bmpBytes: number } | null> {
  let src: Source | undefined
  try {
    src = await source(inputPath)
    const pkg = await inspect(src, kind)
    await unchanged(src)
    return pkg.candidates.length
      ? {
          count: pkg.candidates.length,
          bmpBytes: pkg.candidates.reduce((total, c) => total + c.entry.csize, 0),
        }
      : null
  } catch {
    return null
  } finally {
    await src?.handle.close()
  }
}

interface Replacement {
  name: string
  file?: string
  bytes?: Buffer
  size: number
  crc: number
  method: number
  usize: number
}
function newName(old: string, taken: Set<string>): string {
  const stem = old.slice(0, old.length - posix.extname(old).length)
  let name = `${stem}.jpg`,
    n = 2
  while (taken.has(name.toLowerCase())) name = `${stem}.optimized-${n++}.jpg`
  taken.add(name.toLowerCase())
  return name
}
function patchXml(pkg: Package, renames: Map<string, string>): Map<string, Buffer> {
  const changes = new Map<string, Patch[]>(),
    addedTypes: string[] = []
  const patch = (xml: string, attr: Attr, value: string) => {
    const list = changes.get(xml) ?? []
    list.push({ start: attr.start, end: attr.end, value: escapeXml(value) })
    changes.set(xml, list)
  }
  for (const c of pkg.candidates) {
    const renamed = renames.get(c.entry.name)
    if (!renamed) continue
    for (const ref of c.refs) {
      patch(
        ref.xml,
        ref.attr,
        encodePath(ref.absolute ? `/${renamed}` : posix.relative(ref.base, renamed)),
      )
      if (ref.mime) patch(ref.xml, ref.mime, 'image/jpeg')
    }
    if (pkg.contentTypes) {
      if (c.override) {
        patch('[Content_Types].xml', c.override.attrs.get('PartName')!, `/${encodePath(renamed)}`)
        patch('[Content_Types].xml', c.override.attrs.get('ContentType')!, 'image/jpeg')
      } else {
        const root = pkg.contentTypes.root.name,
          prefix = root.includes(':') ? root.slice(0, root.indexOf(':') + 1) : ''
        addedTypes.push(
          `<${prefix}Override PartName="/${escapeXml(encodePath(renamed))}" ContentType="image/jpeg"/>`,
        )
      }
    }
  }
  if (addedTypes.length) {
    const list = changes.get('[Content_Types].xml') ?? [],
      at = pkg.contentTypes!.close
    if (at < 0) throw unsupported()
    list.push({ start: at, end: at, value: addedTypes.join('') })
    changes.set('[Content_Types].xml', list)
  }
  const out = new Map<string, Buffer>()
  for (const [name, patches] of changes) {
    let text = pkg.xml.get(name)!.text
    const sorted = patches.sort((a, b) => b.start - a.start)
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i]!
      if (i > 0 && p.end > sorted[i - 1]!.start) throw unsupported()
      text = text.slice(0, p.start) + p.value + text.slice(p.end)
    }
    out.set(name, Buffer.from(text))
  }
  return out
}

async function writeArchive(
  src: Source,
  output: FileHandle,
  replacements: Map<string, Replacement>,
  signal?: AbortSignal,
) {
  const central: Buffer[] = []
  let offset = 0
  const write = async (data: Buffer) => {
    let done = 0
    while (done < data.length) {
      checkAbort(signal)
      const result = await output.write(data, done, data.length - done, offset)
      if (!result.bytesWritten) throw new Error('ZIP output write failed')
      done += result.bytesWritten
      offset += result.bytesWritten
    }
  }
  for (const entry of src.entries) {
    checkAbort(signal)
    const replacement = replacements.get(entry.name)
    const name = replacement ? Buffer.from(replacement.name) : entry.nameBytes
    const size = replacement?.size ?? entry.csize,
      usize = replacement?.usize ?? entry.usize,
      method = replacement?.method ?? entry.method,
      crc = replacement?.crc ?? entry.crc
    const flags = (entry.flags & ~8) | (replacement ? 0x800 : 0),
      localOffset = offset
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(entry.verNeed, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(entry.time, 10)
    local.writeUInt16LE(entry.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(usize, 22)
    local.writeUInt16LE(name.length, 26)
    await write(local)
    await write(name)
    if (replacement?.bytes) await write(replacement.bytes)
    else {
      const staging = replacement?.file ? await open(replacement.file, 'r') : null
      try {
        for (let position = 0; position < size; position += CHUNK) {
          const length = Math.min(CHUNK, size - position)
          if (staging) {
            const chunk = Buffer.alloc(length)
            const { bytesRead } = await staging.read(chunk, 0, length, position)
            if (bytesRead !== length) throw unsupported()
            await write(chunk)
          } else await write(await src.read(entry.dataOffset + position, length))
        }
      } finally {
        await staging?.close()
      }
    }
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50)
    header.writeUInt16LE(entry.verMade, 4)
    header.writeUInt16LE(entry.verNeed, 6)
    header.writeUInt16LE(flags, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(entry.time, 12)
    header.writeUInt16LE(entry.date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(size, 20)
    header.writeUInt32LE(usize, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(entry.intAttr, 36)
    header.writeUInt32LE(entry.extAttr, 38)
    header.writeUInt32LE(localOffset, 42)
    central.push(header, name)
  }
  const centralStart = offset
  for (const bytes of central) await write(bytes)
  if (offset > 0xffffffff || src.entries.length >= 65535) throw unsupported()
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(src.entries.length, 8)
  end.writeUInt16LE(src.entries.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  await write(end)
}

export async function optimizeZipBmp(
  inputPath: string,
  outputPath: string,
  kind: ZipDocumentKind,
  encode: (bmp: Buffer) => Promise<Buffer | null>,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<{ converted: number; skipped: number }> {
  checkAbort(options.signal)
  const src = await source(inputPath)
  let temporary: string | undefined,
    output: FileHandle | undefined,
    created = false
  try {
    const pkg = await inspect(src, kind),
      replacements = new Map<string, Replacement>(),
      renames = new Map<string, string>()
    const taken = new Set(pkg.reservedNames)
    temporary = await mkdtemp(join(dirname(outputPath), '.bmp-zip-'))
    let converted = 0,
      skipped = 0,
      done = 0
    for (const candidate of pkg.candidates) {
      checkAbort(options.signal)
      const entry = candidate.entry
      let jpeg: Buffer | null = null
      if (entry.usize <= MAX_BMP && entry.csize <= MAX_BMP) {
        const bmp = await part(src, entry, MAX_BMP)
        if (bmp[0] === 0x42 && bmp[1] === 0x4d) jpeg = await encode(bmp)
      }
      checkAbort(options.signal)
      if (
        jpeg &&
        jpeg.length < Math.min(entry.usize, entry.csize) &&
        jpeg[0] === 255 &&
        jpeg[1] === 216 &&
        jpeg[2] === 255
      ) {
        const name = newName(entry.name, taken),
          file = join(temporary, `${done}.jpg`)
        await writeFile(file, jpeg, { flag: 'wx' })
        replacements.set(entry.name, {
          name,
          file,
          size: jpeg.length,
          usize: jpeg.length,
          method: 0,
          crc: crc32(jpeg),
        })
        renames.set(entry.name, name)
        converted++
      } else skipped++
      options.onProgress?.(++done, pkg.candidates.length)
    }
    for (const [name, bytes] of patchXml(pkg, renames)) {
      const compressed = deflateRawSync(bytes)
      replacements.set(name, {
        name,
        bytes: compressed,
        size: compressed.length,
        usize: bytes.length,
        method: 8,
        crc: crc32(bytes),
      })
    }
    checkAbort(options.signal)
    await unchanged(src)
    output = await open(outputPath, 'wx', 0o600)
    created = true
    await writeArchive(src, output, replacements, options.signal)
    await unchanged(src)
    checkAbort(options.signal)
    await output.sync()
    await output.close()
    output = undefined
    return { converted, skipped }
  } catch (error) {
    await output?.close().catch(() => {})
    if (created) await rm(outputPath, { force: true })
    throw error
  } finally {
    await src.handle.close()
    if (temporary) await rm(temporary, { recursive: true, force: true })
  }
}
