import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { PdfLoadError } from '@genoffice/pdf2docx'
import { flagBool, flagString, type ParsedArgs } from '../args'
import { convertDelimitedText, csvToXlsx, sheetNameFromStem } from '../formats/csv'
import { convertPdf, type PdfTarget } from '../formats/pdf'
import { convertLegacyWorkbook, sheetToCsv, workbookToOds } from '../formats/xlsx'
import { exportViaApp, type AppExportTarget } from '../formats/app-export'
import {
  appTarget,
  bodyTarget,
  conversionPath,
  CONVERSION_ROUTES as ROUTES,
} from '../conversion-routes'
import { htmlToMarkdown, markdownToDocx, markdownToHtml } from '../formats/markdown'
import { closeDocument, documentHtml, openDocument } from '../formats/docx'
import { docxBytesToOdt, openOdtBytes, reportOdtConversion } from '../formats/odt'
import { writeEpubFile, writeMarkdownFile } from '../formats/pdf-outputs'
import {
  documentHash,
  documentTree,
  onlyPageImages,
  parsePageList,
  pdfFacts,
  resultStore,
  withStoredReadings,
} from '../formats/pdf-structure'
import { extension, readInput, resolveInput, resolveOutput, stripBom, writeOutput } from '../fs'
import { assertNotEmptyPackage } from '../limits'
import type { CommandContext, CommandDef } from '../registry'
import { CliError, EXIT } from '../result'

export const convertCommand: CommandDef = {
  name: 'convert',
  summary: 'Convert a document to another format using the GenOffice engines.',
  usage:
    'convert <file> --to <format> [--out <path>] [--force] [--password <pw>] [--sheet <name>] [--pages <list>] [--title <text>] [--author <text>] [--no-cover] [--page-breaks]',
  options: [
    { name: 'to', value: 'format', description: 'target format: ' + describeRoutes() },
    { name: 'out', value: 'path', description: 'output file (default: same name, new extension)' },
    { name: 'force', description: 'overwrite an existing output file' },
    { name: 'password', value: 'pw', description: 'password for an encrypted PDF' },
    {
      name: 'sheet',
      value: 'name',
      description: 'xlsx→csv: worksheet to export (default: the active one)',
    },
    {
      name: 'pages',
      value: 'list',
      description: 'pdf→md/epub: pages like 1-5,8 (default: every page)',
    },
    {
      name: 'title',
      value: 'text',
      description: 'pdf→epub: title (default: from the PDF)',
    },
    {
      name: 'author',
      value: 'text',
      description: 'pdf→epub: author (default: from the PDF)',
    },
    { name: 'no-cover', description: 'pdf→epub: no cover page' },
    {
      name: 'page-breaks',
      description: 'pdf→epub: start each original page on a new screen',
    },
  ],
  async run(args, ctx) {
    const input = resolveInput(args.positionals[0], ctx)
    const from = extension(input)
    assertNotEmptyPackage(input, from)
    const to = flagString(args, 'to')?.toLowerCase()
    if (!to)
      throw new CliError(EXIT.usage, 'missing --to <format>', undefined, {
        reason: 'missing_argument',
      })
    const targets = Object.hasOwn(ROUTES, from) ? ROUTES[from] : undefined
    if (!targets?.includes(to)) {
      throw new CliError(
        EXIT.usage,
        `cannot convert .${from} to .${to}`,
        { supported: describeRoutes() },
        { reason: 'unsupported', suggestion: 'pick a route from detail.supported' },
      )
    }
    assertRouteOptions(args, from, to)
    // before run(): the sidecar and app routes write the output themselves
    const output = resolveOutput(flagString(args, 'out'), ctx, {
      fallback: join(dirname(input), `${basename(input, extname(input))}.${to}`),
      force: flagBool(args, 'force'),
      fresh: true,
    })
    if (samePath(input, output))
      throw new CliError(
        EXIT.usage,
        `output path must differ from the input: ${output}`,
        undefined,
        {
          reason: 'invalid_argument',
          suggestion: 'pass a different --out',
        },
      )
    const result = await runPath(input, conversionPath(from, to)!, output, args, ctx)
    if (result.bytes) writeOutput(output, result.bytes)
    return {
      summary: `converted ${basename(input)} → ${basename(output)}`,
      outputPath: output,
      detail: result.detail,
    }
  },
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return join(realpathSync.native(dirname(p)), basename(p))
    }
  }
  const [x, y] = [real(a), real(b)]
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

interface Produced {
  bytes?: Uint8Array
  detail: Record<string, unknown>
}

async function runPath(
  input: string,
  path: string[],
  output: string,
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<Produced> {
  if (path.length === 2) return run(input, path[0]!, path[1]!, output, args, ctx)
  const warnings = new Set<string>()
  const stepContext: CommandContext = {
    ...ctx,
    warn(warning) {
      const key = JSON.stringify(warning)
      if (!warnings.has(key)) ctx.warn(warning)
      warnings.add(key)
    },
  }
  if (path.slice(1, -1).includes('pdf'))
    stepContext.warn({
      code: 'body_conversion',
      message:
        'The editable body is converted. Page layout, headers, annotations and complex objects may differ from the original.',
    })
  if (path[0] === 'pptx')
    stepContext.warn({
      code: 'printed_content',
      message:
        'Printed slide content is included. Animations and speaker notes are not transferred.',
    })
  const dir = mkdtempSync(join(dirname(output), '.ieumoffice-convert-'))
  try {
    let current = input
    const title = basename(input, extname(input))
    const steps: Record<string, unknown>[] = []
    for (let index = 1; index < path.length; index++) {
      const from = path[index - 1]!
      const to = path[index]!
      const last = index === path.length - 1
      const next = last ? output : join(dir, title + '.' + to)
      const result = await run(current, from, to, next, args, stepContext)
      steps.push(result.detail)
      if (last) return { ...result, detail: { via: path, steps } }
      if (result.bytes) writeOutput(next, result.bytes)
      // Ordinary Markdown uses paths relative to the original file. Embed its assets
      // before handing the HTML to another engine in the temporary folder.
      if (to === 'html' && (from === 'md' || from === 'markdown')) {
        const { conversionHtml } = await import('../formats/conversion-html')
        const { decodeHtmlBytes } = await import('../formats/html-text')
        writeOutput(
          next,
          Buffer.from(await conversionHtml(decodeHtmlBytes(readInput(next)), current, stepContext)),
        )
      }
      current = next
    }
    throw new CliError(EXIT.conversion, 'Incomplete conversion path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runBody(
  input: string,
  from: string,
  to: string,
  ctx: CommandContext,
): Promise<Produced> {
  const { textBodyHtml, conversionHtml, bodyHtmlText } = await import('../formats/conversion-html')
  const { bodyHtmlToEpub, bodyHtmlToXmind, epubBodyHtml, xmindOutlineHtml } =
    await import('../formats/conversion-book-map')
  const { workbookBodyHtml, bodyHtmlToWorkbook } = await import('../formats/conversion-sheet')
  const { decodeHtmlBytes } = await import('../formats/html-text')
  const title = basename(input, extname(input))
  let html: string
  if (from === 'epub') html = await epubBodyHtml(readInput(input), ctx)
  else if (from === 'xmind') html = await xmindOutlineHtml(readInput(input))
  else if (from === 'xlsx' || from === 'xlsm') html = await workbookBodyHtml(input)
  else if (from === 'txt')
    html = textBodyHtml(stripBom(Buffer.from(readInput(input)).toString('utf8')))
  else html = decodeHtmlBytes(readInput(input))
  const detail = { via: 'editable HTML body' }
  if (to === 'txt') return { bytes: Buffer.from(await bodyHtmlText(html)), detail }
  const body = await conversionHtml(html, input, ctx)
  if (to === 'html') return { bytes: Buffer.from(body), detail }
  if (to === 'md') return { bytes: Buffer.from(await htmlToMarkdown(body)), detail }
  if (to === 'epub') return { bytes: await bodyHtmlToEpub(body, title, ctx), detail }
  if (to === 'xmind') return { bytes: await bodyHtmlToXmind(body, title), detail }
  return { bytes: await bodyHtmlToWorkbook(body, sheetNameFromStem(title)), detail }
}

async function run(
  input: string,
  from: string,
  to: string,
  output: string,
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<Produced> {
  const password = flagString(args, 'password')
  if (from === 'json' || to === 'json') {
    const bytes = readInput(input)
    try {
      JSON.parse(stripBom(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    } catch {
      throw new CliError(EXIT.conversion, 'This text is not a valid UTF-8 JSON document.')
    }
    return { bytes, detail: { via: 'validated JSON text' } }
  }
  if (bodyTarget(from, to)) {
    warnBodyConversion(from, to, ctx)
    return runBody(input, from, to, ctx)
  }
  if (from === 'pdf' && to === 'html') {
    return convertPdfViaDocx(input, to, output, password, ctx)
  }
  const viaApp = appTarget(from, to)
  if (viaApp) {
    const r = await exportViaApp(input, viaApp, output, { env: ctx.env, log: ctx.log })
    return { detail: { via: 'ieumoffice --headless-export', summary: r.summary } }
  }
  if (from === 'hwp' || from === 'hwpx' || to === 'hwp' || to === 'hwpx') {
    return runHangul(input, from, to, output, password, ctx)
  }
  if (from === 'odt' || to === 'odt') return runOdt(input, from, to, output, ctx)
  if (from === 'pdf' && (to === 'md' || to === 'epub')) {
    return pdfReflow(input, to, output, args, ctx)
  }
  if (from === 'pdf') {
    const r = await convertPdfOrThrow(input, to as PdfTarget, password, ctx)
    return { bytes: r.bytes, detail: { pages: r.pages, warnings: r.warnings } }
  }
  if (from === 'md' || from === 'markdown') {
    const text = Buffer.from(readInput(input)).toString('utf-8')
    const title = basename(input, extname(input))
    if (to === 'html') {
      return { bytes: Buffer.from(await markdownToHtml(text, title), 'utf-8'), detail: { title } }
    }
    return { bytes: await markdownToDocx(text, { file: input, ctx }), detail: { title } }
  }
  if (from === 'csv' || from === 'tsv') {
    if (to === 'csv' || to === 'tsv')
      return {
        bytes: Buffer.from(convertDelimitedText(readInput(input), from, to)),
        detail: { via: 'delimited text' },
      }
    const sheet = sheetNameFromStem(basename(input, extname(input)))
    return {
      bytes: await csvToXlsx(readInput(input), sheet, from === 'tsv' ? '\t' : undefined),
      detail: { sheet },
    }
  }
  if (to === 'ods') {
    const detail = await workbookToOds(input, output)
    const omitted = Object.entries(detail.dropped)
      .filter(([, count]) => count > 0)
      .map(([feature, count]) => feature + ': ' + count)
    if (detail.formulasDropped) omitted.push('formulas: ' + detail.formulasDropped)
    if (omitted.length)
      ctx.warn({
        code: 'spreadsheet_features_omitted',
        message: 'ODS conversion omitted ' + omitted.join(', '),
      })
    return { detail }
  }
  if (to === 'csv' || to === 'tsv') {
    const { csv, ...detail } = await sheetToCsv(input, {
      sheet: flagString(args, 'sheet'),
      delimiter: to === 'tsv' ? '\t' : ',',
    })
    // UTF-8 BOM, as the app writes it, so Excel opens the file without a wizard
    return { bytes: Buffer.from('\ufeff' + csv, 'utf-8'), detail }
  }
  if (to === 'md') return docxToMarkdown(readInput(input), ctx)
  const r = await convertLegacyWorkbook(input, output)
  if (from === 'xlsm' || r.formulasDropped) {
    ctx.warn({
      code: 'spreadsheet_conversion',
      message:
        'Workbook values and supported formulas are converted. Macros, unsupported formulas and special formatting may be omitted.',
    })
  }
  return { detail: { ...r } }
}

async function docxToMarkdown(docx: Uint8Array, ctx: CommandContext): Promise<Produced> {
  const doc = await openDocument(docx)
  try {
    const exported = documentHtml(doc)
    const markdown = await htmlToMarkdown(exported.html)
    if (exported.nestedTablesAsText > 0) {
      ctx.warn({
        code: 'nested_tables_flattened',
        message: `${exported.nestedTablesAsText} nested table(s) were kept as cell text because Markdown cannot nest tables`,
        suggestion: 'keep the DOCX when nested table layout matters',
      })
    }
    if (exported.skipped.images > 0) {
      ctx.warn({
        code: 'images_dropped',
        message: `${exported.skipped.images} image(s) have no Markdown form and were dropped`,
        suggestion: 'use `ieumoffice docs read --html` when the images matter',
      })
    }
    return {
      bytes: Buffer.from(markdown.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf-8'),
      detail: {
        blocks: doc.editor.state.doc.childCount,
        skipped: exported.skipped,
        formulas_as_text: exported.formulasAsText,
        ...(exported.nestedTablesAsText > 0
          ? { nested_tables_as_text: exported.nestedTablesAsText }
          : {}),
      },
    }
  } finally {
    closeDocument(doc)
  }
}

/** Options that belong to one route only are refused on the others rather than ignored. */
const ROUTE_OPTIONS: [string, (from: string, to: string) => boolean, string][] = [
  ['pages', (from, to) => from === 'pdf' && (to === 'md' || to === 'epub'), 'pdf→md/epub'],
  ['title', (from, to) => from === 'pdf' && to === 'epub', 'pdf→epub'],
  ['author', (from, to) => from === 'pdf' && to === 'epub', 'pdf→epub'],
  ['no-cover', (from, to) => from === 'pdf' && to === 'epub', 'pdf→epub'],
  ['page-breaks', (from, to) => from === 'pdf' && to === 'epub', 'pdf→epub'],
]

function assertRouteOptions(args: ParsedArgs, from: string, to: string): void {
  for (const [option, applies, route] of ROUTE_OPTIONS) {
    if (args.flags[option] === undefined || applies(from, to)) continue
    throw new CliError(EXIT.usage, `--${option} applies to ${route} only`, undefined, {
      reason: 'invalid_argument',
    })
  }
}

/**
 * Runs `work` on a temporary document written beside the output (inside the
 * allowed roots the output already passed), and always deletes it.
 */
async function withTempDocument<T>(
  output: string,
  name: string,
  bytes: Uint8Array | null,
  work: (path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(dirname(output), '.ieumoffice-convert-'))
  try {
    const path = join(dir, name)
    if (bytes) writeOutput(path, bytes)
    return await work(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function warnBodyConversion(from: string, to: string, ctx: CommandContext) {
  ctx.warn({
    code: 'body_conversion',
    message:
      'The editable body is converted. Page layout, headers, annotations and complex objects may differ from the original.',
  })
  if (from === 'xmind' || to === 'xmind') {
    ctx.warn({
      code: 'map_outline',
      message:
        'Mind maps exchange topic outlines. Map styling, images and graphical relationships are not transferred.',
    })
  }
  if (from === 'epub' || to === 'epub') {
    ctx.warn({
      code: 'epub_body',
      message:
        'Book content is converted in reading order. Fixed layout, interactive media and book navigation can change.',
    })
  }
  if (from === 'xlsx' || from === 'xlsm') {
    ctx.warn({
      code: 'worksheet_display_values',
      message:
        'Visible worksheets are converted to tables using displayed cell values. Formulas, charts and macros are not transferred.',
    })
  }
}

/** Keep native Hangul documents on their checked serializer. Other word processing
 * formats exchange their editable body via the same HTML exporters as their editors. */
async function runHangul(
  input: string,
  from: string,
  to: string,
  output: string,
  password: string | undefined,
  ctx: CommandContext,
): Promise<Produced> {
  const { convertHangulNative, hangulToHtml, htmlToHangul } =
    await import('../formats/hwp-conversion')
  const { workbookBodyHtml, bodyHtmlToWorkbook } = await import('../formats/conversion-sheet')
  const fromHangul = from === 'hwp' || from === 'hwpx'
  const toHangul = to === 'hwp' || to === 'hwpx'
  if (fromHangul && toHangul) {
    return {
      bytes: await convertHangulNative(readInput(input), to, ctx),
      detail: { via: 'native Hangul export' },
    }
  }
  if (to === 'txt') {
    const { hwpText } = await import('../formats/hwp')
    return { bytes: Buffer.from(await hwpText(readInput(input)), 'utf-8'), detail: {} }
  }

  const appOptions = { env: ctx.env, log: ctx.log }
  if (to === 'pptx') {
    // Page-based formats use the same printed pages and document reconstruction
    // as a PDF opened separately, without touching either original.
    return withTempDocument(output, 'pages.pdf', null, async (pdf) => {
      await exportViaApp(input, 'pdf', pdf, appOptions)
      const result = await convertPdfOrThrow(pdf, to, undefined, ctx)
      return {
        bytes: result.bytes,
        detail: { via: 'printed PDF pages', pages: result.pages, warnings: result.warnings },
      }
    })
  }
  const detail = { via: 'editable HTML body' }
  warnBodyConversion(from, to, ctx)
  if (fromHangul) {
    const html = await hangulToHtml(readInput(input))
    if (to === 'epub' || to === 'xmind') {
      const { bodyHtmlToEpub, bodyHtmlToXmind } = await import('../formats/conversion-book-map')
      const title = basename(input, extname(input))
      const bytes =
        to === 'epub' ? await bodyHtmlToEpub(html, title, ctx) : await bodyHtmlToXmind(html, title)
      return { bytes, detail }
    }
    if (to === 'xlsx')
      return {
        bytes: await bodyHtmlToWorkbook(html, sheetNameFromStem(basename(input, extname(input)))),
        detail,
      }
    if (to === 'html') return { bytes: Buffer.from(html), detail }
    if (to === 'md') return { bytes: Buffer.from(await htmlToMarkdown(html)), detail }
    return withTempDocument(output, 'body.html', Buffer.from(html), async (path) => {
      if (to === 'docx') {
        await exportViaApp(path, 'docx', output, appOptions)
        return { detail }
      }
      return withTempDocument(output, 'body.docx', null, async (docx) => {
        await exportViaApp(path, 'docx', docx, appOptions)
        const { odtBytes, report } = await docxBytesToOdt(readInput(docx))
        return {
          bytes: odtBytes,
          detail: { ...detail, odt_report: reportOdtConversion(report, to, ctx) },
        }
      })
    })
  }
  if (!toHangul) throw new CliError(EXIT.usage, 'unsupported Hangul conversion')
  const { decodeHtmlBytes } = await import('../formats/html-text')
  async function docxHtml(path: string): Promise<string> {
    return withTempDocument(output, 'body.html', null, async (html) => {
      await exportViaApp(path, 'html', html, appOptions)
      return decodeHtmlBytes(readInput(html))
    })
  }
  let html: string
  switch (from) {
    case 'epub': {
      const { epubBodyHtml } = await import('../formats/conversion-book-map')
      html = await epubBodyHtml(readInput(input), ctx)
      break
    }
    case 'xmind': {
      const { xmindOutlineHtml } = await import('../formats/conversion-book-map')
      html = await xmindOutlineHtml(readInput(input))
      break
    }
    case 'txt':
      html = stripBom(Buffer.from(readInput(input)).toString('utf8'))
        .split(/\r\n|\n|\r/)
        .map(
          (line) =>
            '<p>' +
            line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
            '</p>',
        )
        .join('')
      break
    case 'md':
    case 'markdown':
      html = await markdownToHtml(
        stripBom(Buffer.from(readInput(input)).toString('utf8')),
        basename(input),
      )
      break
    case 'htm':
    case 'html':
      html = decodeHtmlBytes(readInput(input))
      break
    case 'docx':
      html = await docxHtml(input)
      break
    case 'odt': {
      const { docxBytes, origin } = await openOdtBytes(readInput(input))
      reportOdtConversion(origin.report, to, ctx)
      html = await withTempDocument(output, 'body.docx', docxBytes, docxHtml)
      break
    }
    case 'xlsx':
    case 'xlsm':
      html = await workbookBodyHtml(input)
      break
    case 'pdf':
    case 'pptx': {
      const reconstruct = (path: string) => convertPdfOrThrow(path, 'docx', password, ctx)
      const reconstructed =
        from === 'pdf'
          ? await reconstruct(input)
          : await withTempDocument(output, 'pages.pdf', null, async (pdf) => {
              await exportViaApp(input, 'pdf', pdf, appOptions)
              return reconstruct(pdf)
            })
      if (from !== 'pdf') {
        ctx.warn({
          code: 'printed_content',
          message:
            'Printed slide content is included. Animations and speaker notes are not transferred.',
        })
      }
      html = await withTempDocument(output, 'body.docx', reconstructed.bytes, docxHtml)
      break
    }
    default:
      throw new CliError(EXIT.usage, 'unsupported Hangul input')
  }
  return { bytes: await htmlToHangul(html, input, to, ctx), detail }
}

async function runOdt(
  input: string,
  from: string,
  to: string,
  output: string,
  ctx: CommandContext,
): Promise<Produced> {
  const stem = basename(input, extname(input))
  if (from === 'odt') {
    const { docxBytes, origin } = await openOdtBytes(readInput(input))
    const odt_report = reportOdtConversion(origin.report, to, ctx)
    if (to === 'docx') return { bytes: docxBytes, detail: { odt_report } }
    if (to === 'md') {
      const r = await docxToMarkdown(docxBytes, ctx)
      return { ...r, detail: { ...r.detail, odt_report } }
    }
    const target = to as AppExportTarget
    const r = await withTempDocument(output, `${stem}.docx`, docxBytes, (docx) =>
      exportViaApp(docx, target, output, { env: ctx.env, log: ctx.log }),
    )
    return { detail: { via: 'ieumoffice --headless-export', summary: r.summary, odt_report } }
  }
  let docx: Uint8Array
  const detail: Record<string, unknown> = {}
  if (from === 'docx') docx = readInput(input)
  else if (from === 'md' || from === 'markdown') {
    const text = Buffer.from(readInput(input)).toString('utf-8')
    docx = await markdownToDocx(text, { file: input, ctx })
  } else {
    docx = await withTempDocument(output, `${stem}.docx`, null, async (path) => {
      await exportViaApp(input, 'docx', path, { env: ctx.env, log: ctx.log })
      return new Uint8Array(readFileSync(path))
    })
    detail.via = 'ieumoffice --headless-export'
  }
  const { odtBytes, report } = await docxBytesToOdt(docx)
  return {
    bytes: odtBytes,
    detail: { ...detail, odt_report: reportOdtConversion(report, to, ctx) },
  }
}

/**
 * pdf→md / pdf→epub (spec §3, §5): the reflowed document tree of the chosen
 * pages, with the pages read by AI as read, written the way the PDF editor
 * writes it (Markdown with `assets/` beside it).
 */
async function pdfReflow(
  input: string,
  to: 'md' | 'epub',
  output: string,
  args: ParsedArgs,
  ctx: CommandContext,
): Promise<Produced> {
  const password = flagString(args, 'password')
  const bytes = readInput(input)
  const spec = flagString(args, 'pages')
  const pages =
    spec === undefined ? undefined : parsePageList(spec, (await pdfFacts(bytes, password)).pages)
  const extracted = await documentTree(bytes, {
    ...(password !== undefined ? { password } : {}),
    ...(pages !== undefined ? { pages } : {}),
    onProgress: (done, total) => ctx.log(`page ${done}/${total}`),
  })
  const { tree, aiPages } = await withStoredReadings(
    extracted,
    resultStore(ctx.env),
    documentHash(bytes),
  )
  if (onlyPageImages(tree)) {
    ctx.warn({
      code: 'pages_as_images',
      message:
        'every page is a picture without readable text, so the result holds page images only',
      suggestion: `read the pages with \`ieumoffice pdf ai-read ${basename(input)} --pages <list>\` first, then convert again`,
    })
  }
  const source = {
    pdfPath: input,
    ...(password !== undefined ? { password } : {}),
    ...(pages !== undefined ? { pages } : {}),
  }
  const common = { pages: tree.pages.length, ...(aiPages.length ? { ai_read_pages: aiPages } : {}) }
  if (to === 'md') {
    const md = await writeMarkdownFile(source, tree, output)
    return { detail: { ...common, ...md } }
  }
  const title = flagString(args, 'title') || tree.info.title || basename(input, extname(input))
  const author = flagString(args, 'author') ?? tree.info.author
  const cover = !flagBool(args, 'no-cover')
  const pageBreaks = flagBool(args, 'page-breaks')
  await writeEpubFile(source, tree, output, {
    title,
    ...(author ? { author } : {}),
    cover,
    ...(pageBreaks ? { pageBreaks: true } : {}),
  })
  return {
    detail: {
      ...common,
      title,
      ...(author ? { author } : {}),
      cover,
      ...(pageBreaks ? { page_breaks: true } : {}),
    },
  }
}

function describeRoutes(): string {
  return Object.entries(ROUTES)
    .map(([from, tos]) => `${from}→${tos.join('/')}`)
    .join(', ')
}

/**
 * PDF → Markdown / HTML goes through the Word reconstruction: pdf2docx
 * rebuilds paragraphs, headings, lists and tables, then the docx routes
 * serialize them. Markdown stays in-process; HTML needs the Word editor's
 * exporter, so the intermediate .docx is handed to the app from a temp dir.
 */
async function convertPdfViaDocx(
  input: string,
  to: 'md' | 'html',
  output: string,
  password: string | undefined,
  ctx: CommandContext,
): Promise<Produced> {
  const pdf = await convertPdfOrThrow(input, 'docx', password, ctx)
  const via = { pages: pdf.pages, warnings: pdf.warnings, intermediate: 'docx' }
  if (to === 'md') {
    const md = await docxToMarkdown(pdf.bytes, ctx)
    return { bytes: md.bytes, detail: { ...via, ...md.detail } }
  }
  const dir = mkdtempSync(join(tmpdir(), 'genoffice-convert-'))
  const docxPath = join(dir, `${basename(input, extname(input))}.docx`)
  try {
    writeFileSync(docxPath, pdf.bytes)
    const r = await exportViaApp(docxPath, 'html', output, { env: ctx.env, log: ctx.log })
    return { detail: { ...via, via: 'genoffice --headless-export', summary: r.summary } }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      ctx.log(`could not remove temp dir ${dir}: ${String(err)}`)
    }
  }
}

async function convertPdfOrThrow(
  input: string,
  target: PdfTarget,
  password: string | undefined,
  ctx: CommandContext,
) {
  try {
    return await convertPdf(readInput(input), target, {
      password,
      onProgress: (page, total) => ctx.log(`page ${page}/${total}`),
    })
  } catch (err) {
    if (err instanceof PdfLoadError) {
      const code = err.code === 'password-required' ? EXIT.file : EXIT.conversion
      throw new CliError(code, err.message, { reason: err.code })
    }
    throw err
  }
}
