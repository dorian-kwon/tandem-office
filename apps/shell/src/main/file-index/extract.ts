import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { REDACT_NS } from '@genoffice/agent-core/redact-range'
import {
  ParseSidecarClient,
  SIDECAR_EXTS,
  SidecarInfraError,
  isParseSidecarEnabled,
  parseFileToText,
  redactHtmlSource,
  type SidecarTokens,
} from '@genoffice/file-parse'
import { INDEX_STREAMING_EXTS, MAX_BODY_CHARS, MAX_EXTRACT_BYTES } from './limits'
export { MAX_EXTRACT_BYTES } from './limits'

export type Extracted =
  | { kind: 'text'; text: string; tokens?: SidecarTokens }
  | { kind: 'name-only' }
  | { kind: 'error'; error: string }

const MARKUP_EXTS = new Set(['html', 'htm'])

function stripMarkup(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export async function extractText(path: string, sidecar?: ParseSidecarClient): Promise<Extracted> {
  try {
    const st = await stat(path)
    const ext = extname(path).slice(1).toLowerCase()
    if (st.size > MAX_EXTRACT_BYTES && !INDEX_STREAMING_EXTS.has(ext)) return { kind: 'name-only' }
    if (sidecar && isParseSidecarEnabled() && SIDECAR_EXTS.has(ext)) {
      try {
        const result = await sidecar.extractFile({
          path,
          ext,
          tokenize: true,
          maxBodyChars: MAX_BODY_CHARS,
          redactNamespaces: [REDACT_NS],
        })
        if (result.status === 'ok')
          return { kind: 'text', text: result.text, tokens: result.tokens }
        if (result.status === 'unsupported') return { kind: 'name-only' }
        if (result.status === 'rejected') return { kind: 'error', error: result.message }
      } catch (error) {
        if (
          !(error instanceof SidecarInfraError) ||
          error.code === 'request_timeout' ||
          error.code === 'stopped'
        )
          throw error
      }
    }
    if (MARKUP_EXTS.has(ext)) {
      // what the page withholds from a model goes before the tags do: the index
      // feeds excerpts to the knowledge base and the reranker. A mark that cannot
      // be processed throws, and the catch below keeps the body out of the index
      return {
        kind: 'text',
        text: stripMarkup(redactHtmlSource(await readFile(path, 'utf-8'))).slice(0, MAX_BODY_CHARS),
      }
    }
    const parsed = await parseFileToText(path, { skipSidecar: true, maxChars: MAX_BODY_CHARS })
    if (parsed.kind === 'unsupported') return { kind: 'name-only' }
    if (!parsed.ok || parsed.kind !== 'text')
      return { kind: 'error', error: parsed.error ?? 'parse failed' }
    return { kind: 'text', text: (parsed.text ?? '').slice(0, MAX_BODY_CHARS) }
  } catch (e) {
    return { kind: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}
