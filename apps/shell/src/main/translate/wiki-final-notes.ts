import type { Lang } from '@genoffice/i18n'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, join, win32 } from 'node:path'
import { wikiLabels } from './wiki-vault-labels'
import { ensureWikiDirectory, prepareTranslationVault, seedNote } from './wiki-vault'

export const FINAL_NOTES_FOLDER = 'final-documents'
const CATALOG = 'final-documents.md'
const MAX_EXAMPLES = 8
const EXCERPT_CHARS = 280
const labels: Record<Lang, readonly [catalog: string, extractedLine: string]> = {
  ko: ['완성본', '추출 본문 행'],
  en: ['Final documents', 'Extracted text line'],
  zh: ['定稿文件', '提取文本行'],
  'zh-TW': ['定稿文件', '擷取文字行'],
  ja: ['完成文書', '抽出テキストの行'],
  fr: ['Documents définitifs', 'Ligne du texte extrait'],
  de: ['Endfassungen', 'Zeile im extrahierten Text'],
  es: ['Documentos finales', 'Línea del texto extraído'],
  th: ['เอกสารฉบับสมบูรณ์', 'บรรทัดของข้อความที่แยกมา'],
  id: ['Dokumen akhir', 'Baris teks hasil ekstraksi'],
  ru: ['Готовые документы', 'Строка извлечённого текста'],
  ar: ['المستندات النهائية', 'سطر النص المستخرج'],
  pt: ['Documentos finais', 'Linha do texto extraído'],
  it: ['Documenti finali', 'Riga del testo estratto'],
  pl: ['Dokumenty końcowe', 'Wiersz wyodrębnionego tekstu'],
  cs: ['Konečné dokumenty', 'Řádek extrahovaného textu'],
  nl: ['Definitieve documenten', 'Regel in de uitgelezen tekst'],
  ms: ['Dokumen akhir', 'Baris teks yang diekstrak'],
  he: ['מסמכים סופיים', 'שורה בטקסט שחולץ'],
  hi: ['अंतिम दस्तावेज़', 'निकाले गए पाठ की पंक्ति'],
  vi: ['Tài liệu hoàn thiện', 'Dòng văn bản đã trích xuất'],
}

type Example = { line: number; text: string }

/** Never promote parser-generated notices or a reviewer's comments to finished wording. */
function* bodyLines(text: string, ext: string): Generator<Example> {
  let line = 0
  let inAnnotations = false
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
    line++
    const value = match[0].trim()
    if (ext === '.pptx' || ext === '.ppt') {
      if (/^## Slide \d+$/.test(value)) {
        inAnnotations = false
        continue
      }
      if (value === '### Notes' || value === '### Comments') inAnnotations = true
    } else if (ext === '.docx' && /^## (Header|Footer|Endnotes|Footnotes|Comments)$/.test(value)) {
      inAnnotations = value === '## Comments'
      continue
    } else if ((ext === '.hwp' || ext === '.hwpx') && value === '### Comments') {
      break
    } else if (['.xlsx', '.xlsm', '.xls'].includes(ext) && value.startsWith('# ')) {
      continue
    }
    if (inAnnotations || !/\p{L}/u.test(value)) continue
    if (
      /^\[No extractable text:|^\[(?:image-only (?:document|sheet)|picture-only slide):|^\[Chapter .* left out:/.test(
        value,
      )
    )
      continue
    // Trim the prefix at a word boundary when possible; line numbers refer to the
    // extractor output, which can flatten tables or join page text onto one line.
    let excerpt = value
    if (excerpt.length > EXCERPT_CHARS) {
      excerpt = excerpt.slice(0, EXCERPT_CHARS).replace(/[\uD800-\uDBFF]$/, '')
      const space = excerpt.lastIndexOf(' ')
      if (space >= EXCERPT_CHARS * 0.7) excerpt = excerpt.slice(0, space)
      excerpt += '…'
    }
    yield { line, text: excerpt }
  }
}

/** Spread the examples across the document, keeping only the selected excerpts in memory. */
function examplesOf(text: string, ext: string): Example[] {
  let count = 0
  const lines = bodyLines(text, ext)
  while (!lines.next().done) count++
  const total = Math.min(count, MAX_EXAMPLES)
  const wanted = new Set(
    Array.from({ length: total }, (_, i) => Math.round((i * (count - 1)) / Math.max(1, total - 1))),
  )
  const selected: Example[] = []
  let index = 0
  for (const example of bodyLines(text, ext)) {
    if (wanted.has(index++) && !selected.some((s) => s.text === example.text))
      selected.push(example)
  }
  return selected
}

// The only mutable entry is a link in the home note. The shell owns one process
// per profile. Appending the link retains any text the user has added in Obsidian.
let linking = Promise.resolve()
function linkCatalog(indexPath: string, title: string): Promise<void> {
  const task = linking.then(async () => {
    const index = await open(
      indexPath,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    )
    try {
      const stat = await index.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Expected a private wiki index')
      const current = await index.readFile('utf8')
      if (!current.includes('](' + CATALOG + ')')) {
        await index.appendFile('\n- [' + title + '](' + CATALOG + ')\n')
      }
    } finally {
      await index.close()
    }
  })
  linking = task.catch(() => {})
  return task
}

export async function ingestFinalNote(
  profileDir: string,
  lang: Lang,
  fileName: string,
  extractedText: string,
  revision?: string,
): Promise<'added' | 'duplicate' | 'empty'> {
  const name = basename(win32.basename(fileName)).normalize('NFC')
  const ext = extname(name).toLowerCase()
  const examples = examplesOf(extractedText, ext)
  if (!examples.length) return 'empty'

  const digest = createHash('sha256')
    .update(name)
    .update('\0')
    .update(revision ?? extractedText)
    .digest('hex')
  const { vaultPath, indexPath } = await prepareTranslationVault(profileDir, lang)
  const stagingDir = dirname(vaultPath)
  const folder = join(vaultPath, FINAL_NOTES_FOLDER)
  await ensureWikiDirectory(folder)
  const [catalog, lineLabel] = labels[lang]
  const [wiki, , , , , style] = wikiLabels[lang]
  // The built-in Obsidian search view finds every finished note, even if the user
  // edits or renames its title. No growing shared file needs to be rewritten.
  await seedNote(
    stagingDir,
    join(vaultPath, CATALOG),
    [
      '# ' + catalog,
      '',
      '[' + wiki + '](index.md)',
      '',
      '```query',
      'path:"' + FINAL_NOTES_FOLDER + '/"',
      '```',
      '',
    ].join('\n'),
  )
  await linkCatalog(indexPath, catalog)

  const stem = name
    .slice(0, 60)
    .replace(/[^\p{L}\p{M}\p{N} -]/gu, '_')
    .trim()
  const path = join(folder, (stem || 'document') + '-' + digest.slice(0, 20) + '.md')
  // Source text belongs in literal blocks so a link, image or Markdown command
  // in a finished document cannot become active content of a generated note.
  const heading = name.replace(/[^\p{L}\p{M}\p{N} ]/gu, (c) => '&#' + c.codePointAt(0) + ';')
  const note = [
    '---',
    'kind: final-style-example',
    'source: ' + JSON.stringify(name),
    'revision: ' + digest,
    'source_format: ' + JSON.stringify(ext.slice(1)),
    // Leave scope properties available in Obsidian until the reader can verify them.
    'institution: null',
    'industry: null',
    'document_type: null',
    'source_language: null',
    'target_language: null',
    '---',
    '# ' + heading,
    '',
    '[' + catalog + '](../' + CATALOG + ') · [' + style + '](../style.md)',
    '',
    ...examples.flatMap(({ line, text }) => [
      '### ' + lineLabel + ' ' + line,
      '',
      '    ' + text,
      '',
    ]),
  ].join('\n')
  return (await seedNote(stagingDir, path, note)) ? 'added' : 'duplicate'
}
