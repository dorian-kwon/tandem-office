import type { ChatOcrAnswer, ChatOcrRequest } from '@genoffice/project-store/folder-api'
import type { OcrService } from './ocr'
import type { OcrPageResult, OcrPlacement, OcrPrepared } from '../../shared/translate-ocr'
import { readAiPage } from '../../../../../packages/pdf-structure/src/ai-read/read-page'
import type { AiReadRequest } from '../../../../../packages/pdf-structure/src/ai-read/instruction'
import { resolveOcrSelection } from '../../shared/translate-ocr'
import { asPictureRequest } from '../../shared/ocr-picture-instruction'

export interface ChatOcrContext {
  docPath: string | null
  projectRoot: string | null
}
export interface ChatOcrRoute {
  provider: string
  model: string
  paid: boolean
}
export interface OcrChatDeps {
  ocr: OcrService
  resolve(
    owner: number,
    input: ChatOcrRequest,
    context: ChatOcrContext,
  ): Promise<{ dir: string; file: string } | { files: string[] }>
  route(ocr: Extract<OcrPrepared['ocr'], { kind: 'ai' }>): ChatOcrRoute
  ask(
    route: ChatOcrRoute,
    request: AiReadRequest,
    signal: AbortSignal,
    owner: number,
  ): Promise<string>
  now(): number
  newToken(): string
}
interface Session {
  id: string
  owner: number
  dir: string
  file: string
  context: string
  prepared: OcrPrepared
  inspectTurn: string
  listTurn?: string
  route?: ChatOcrRoute
  allowed: Set<number>
  pages: Map<number, OcrPageResult>
  edits: Map<number, OcrPageResult>
  touched: number
  busy: boolean
  proposal?: { placement: OcrPlacement; pages: OcrPageResult[]; turn: string }
}
class Refusal extends Error {}
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Refusal(message)
}
function contextKey(context: ChatOcrContext) {
  return JSON.stringify([context.projectRoot, context.docPath])
}
function plain(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(plain).filter(Boolean).join('\n')
  const obj = value as Record<string, unknown>
  if (typeof obj.text === 'string') return obj.text
  return Object.values(obj).map(plain).filter(Boolean).join('\n')
}
const answer = (value: unknown, extra: Partial<ChatOcrAnswer> = {}): ChatOcrAnswer => ({
  output: JSON.stringify(value),
  summary: 'OCR',
  ...extra,
})

/** Conversational state only: no dialog, no output until agreement on a later human turn. */
export function createOcrChatService(deps: OcrChatDeps) {
  const sessions = new Map<string, Session>()
  const active = new Map<string, { owner: number; session?: string; controller: AbortController }>()
  function release(s: Session) {
    sessions.delete(s.id)
    void deps.ocr.release(s.prepared.token).catch(() => undefined)
  }
  function held(owner: number, input: ChatOcrRequest, context: ChatOcrContext) {
    const session = typeof input.session === 'string' ? sessions.get(input.session) : undefined
    requireThat(
      session && session.owner === owner,
      'Inspect this document again; this OCR session is unavailable.',
    )
    requireThat(
      session.context === contextKey(context),
      'The active document or project changed. Inspect the current document again.',
    )
    requireThat(!session.busy, 'This OCR session is already processing a request.')
    session.touched = deps.now()
    return session
  }
  async function execute(
    owner: number,
    input: ChatOcrRequest,
    context: ChatOcrContext,
  ): Promise<ChatOcrAnswer> {
    if (!input || typeof input !== 'object')
      return answer({ error: 'Invalid OCR request' }, { isError: true })
    const requestKey = `${owner}:${input.requestId ?? deps.newToken()}`
    if (input.action === 'cancel') {
      let cancelled = false
      const request = active.get(requestKey)
      if (request) {
        request.controller.abort()
        cancelled = true
      }
      const session = input.session ? sessions.get(input.session) : undefined
      if (session && session.owner === owner && session.context === contextKey(context)) {
        for (const entry of active.values())
          if (entry.owner === owner && entry.session === session.id) entry.controller.abort()
        release(session)
        cancelled = true
      }
      return answer({ cancelled })
    }
    const controller = new AbortController()
    if (active.has(requestKey))
      return answer({ error: 'This OCR request is already active' }, { isError: true })
    active.set(requestKey, { owner, session: input.session, controller })
    try {
      requireThat(
        typeof input.turnId === 'string' && input.turnId.length > 0 && input.turnId.length <= 128,
        'A human chat turn is required.',
      )
      for (const s of sessions.values())
        if (deps.now() - s.touched > 30 * 60_000 && !s.busy) release(s)
      if (input.action === 'inspect') {
        const source = await deps.resolve(owner, input, context)
        if ('files' in source)
          return answer({
            files: source.files,
            next: 'Ask which document the person wants to OCR.',
          })
        requireThat(
          /\.(docx|xlsx)$/i.test(source.file),
          'Conversational embedded OCR currently supports DOCX and XLSX. No format conversion was performed.',
        )
        for (const s of sessions.values())
          if (s.owner === owner && s.dir === source.dir) {
            requireThat(!s.busy, 'An OCR request is still processing.')
            release(s)
          }
        requireThat(
          sessions.size < 16,
          'Finish or cancel an earlier OCR session before inspecting another document.',
        )
        const prepared = await deps.ocr.prepare(source.dir, [source.file], owner)
        if (controller.signal.aborted) {
          await deps.ocr.release(prepared.token)
          controller.signal.throwIfAborted()
        }
        requireThat(
          prepared.kind === 'embedded' && prepared.ocr.kind === 'ai',
          'OCR is not enabled for this document.',
        )
        let route: ChatOcrRoute | undefined
        try {
          route = deps.route(prepared.ocr)
        } catch {
          /* listing stays local while the OCR provider is unavailable */
        }
        const session: Session = {
          id: deps.newToken(),
          owner,
          dir: source.dir,
          file: source.file,
          context: contextKey(context),
          prepared,
          inspectTurn: input.turnId,
          route,
          allowed: new Set(),
          pages: new Map(),
          edits: new Map(),
          touched: deps.now(),
          busy: false,
        }
        sessions.set(session.id, session)
        return answer({
          session: session.id,
          file: source.file,
          format: prepared.format,
          imageCount: prepared.items.length,
          sheets: prepared.sheets,
          tables: prepared.tables,
          ocr: route ?? { available: false },
          next: 'Ask in chat: all images or selected images? No image has been sent and no document changed.',
        })
      }
      const s = held(owner, input, context)
      const prepared = s.prepared
      if (input.action === 'list') {
        s.busy = true
        try {
          s.listTurn = input.turnId
          const offset = Number.isInteger(input.offset) && input.offset! >= 0 ? input.offset! : 0
          const limit = Math.min(50, Math.max(1, Number.isInteger(input.limit) ? input.limit! : 20))
          const items = prepared.items.slice(offset, offset + limit)
          const thumbnails: { url: string; title: string; thumb: string }[] = []
          for (const item of items.slice(0, 6)) {
            controller.signal.throwIfAborted()
            const preview = await deps.ocr.preview(prepared.token, item.index).catch(() => null)
            if (preview) {
              const url = `data:${preview.mime};base64,${Buffer.from(preview.data).toString('base64')}`
              thumbnails.push({
                url,
                thumb: url,
                title: `${item.index}. ${item.name} · ${item.location ?? ''}`,
              })
            }
          }
          return answer(
            {
              session: s.id,
              total: prepared.items.length,
              items,
              nextOffset:
                offset + items.length < prepared.items.length ? offset + items.length : null,
              next: 'Show this list and wait for the person to select image numbers. Do not OCR images on this turn.',
            },
            thumbnails.length ? { display: { kind: 'images', items: thumbnails } } : {},
          )
        } finally {
          s.busy = false
        }
      }
      if (input.action === 'review') {
        requireThat(
          Array.isArray(input.pages) && input.pages.length === 1,
          'Review one recognised image number at a time.',
        )
        const page = s.edits.get(input.pages[0]!) ?? s.pages.get(input.pages[0]!)
        requireThat(page, 'Read this image before reviewing its text.')
        const text = plain(page.payload)
        const offset = Number.isInteger(input.offset) && input.offset! >= 0 ? input.offset! : 0
        const limit = Math.min(
          4000,
          Math.max(1, Number.isInteger(input.limit) ? input.limit! : 2000),
        )
        return answer({
          session: s.id,
          index: page.index,
          text: text.slice(offset, offset + limit),
          totalCharacters: text.length,
          nextOffset: offset + limit < text.length ? offset + limit : null,
        })
      }
      if (input.action === 'read') {
        requireThat(
          input.turnId !== s.inspectTurn && input.turnId !== s.listTurn,
          'Ask for the scope or show the list, then wait for the person’s image selection on a later turn.',
        )
        const wanted = resolveOcrSelection(
          input.all === true ? { kind: 'all' } : { kind: 'pages', pages: input.pages ?? [] },
          prepared.items.length,
        )
        const missing = wanted.filter((i) => !s.pages.has(i)).slice(0, 20)
        s.busy = true
        try {
          if (missing.length) {
            requireThat(prepared.ocr.kind === 'ai', 'OCR is switched off.')
            const route = deps.route(prepared.ocr)
            requireThat(
              !s.route || JSON.stringify(s.route) === JSON.stringify(route),
              'The OCR provider or its cost changed. Inspect the document and confirm the scope again.',
            )
            s.route = route
            if (wanted.some((i) => !s.allowed.has(i))) {
              if (s.allowed.size) {
                await deps.ocr.release(s.prepared.token)
                s.prepared = await deps.ocr.prepare(s.dir, [s.file], owner)
              }
              const union = [...new Set([...s.pages.keys(), ...wanted])].sort((a, b) => a - b)
              await deps.ocr.start(s.prepared.token, union)
              s.allowed = new Set(union)
            }
            for (const index of missing) {
              controller.signal.throwIfAborted()
              const image = await deps.ocr.pageImage(s.prepared.token, index)
              controller.signal.throwIfAborted()
              const reading = await readAiPage({
                page: index,
                pageFingerprint: '',
                image: image.data,
                mime: image.mime,
                signal: controller.signal,
                // pictures inside a document: the text in drawings counts
                ask: (request, signal) => deps.ask(route, asPictureRequest(request), signal, owner),
              })
              s.pages.set(index, { index, payload: reading.payload })
              s.proposal = undefined
              requireThat(
                JSON.stringify([...s.pages.values()]).length <= 8 * 1024 * 1024,
                'OCR session text limit reached. Review the recognised images before continuing.',
              )
            }
          }
          const recognised = wanted.filter((i) => s.pages.has(i))
          const remaining = wanted.filter((i) => !s.pages.has(i))
          return answer({
            session: s.id,
            file: s.file,
            recognised,
            remaining,
            results: recognised.slice(-20).map((index) => ({
              index,
              location: prepared.items[index - 1]?.location,
              text: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).slice(0, 2000),
              totalCharacters: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).length,
              truncated: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).length > 2000,
            })),
            next: remaining.length
              ? 'Continue only within the scope the person already requested. Each read call processes at most 20 new images.'
              : 'Review the OCR text in chat, then propose where to put it. No output file exists yet.',
          })
        } finally {
          s.busy = false
        }
      }
      if (input.action === 'propose') {
        requireThat(s.pages.size > 0, 'Read the selected images before proposing a destination.')
        const pages = [...s.pages.values()]
          .sort((a, b) => a.index - b.index)
          .map((p) => ({ ...(s.edits.get(p.index) ?? p) }))
        if (input.texts !== undefined) {
          requireThat(
            Array.isArray(input.texts) && input.texts.length <= 20,
            'Revise at most 20 recognised images at a time.',
          )
          const seen = new Set<number>()
          for (const edit of input.texts) {
            const page = pages.find((p) => p.index === edit?.index)
            requireThat(
              page &&
                typeof edit.text === 'string' &&
                edit.text.length <= 32767 &&
                !seen.has(edit.index),
              'Only recognised image text may be corrected or translated.',
            )
            seen.add(edit.index)
            page.payload = {
              version: 1,
              blocks: [{ kind: 'paragraph', runs: [{ kind: 'text', text: edit.text }] }],
              footnotes: [],
              droppedRepetitions: 0,
              reasked: false,
            }
          }
        }
        s.busy = true
        try {
          const recommendation = await deps.ocr.recommend(
            s.prepared.token,
            pages.map((p) => p.index),
          )
          const placement = input.placement ?? recommendation.placement
          requireThat(
            placement && typeof placement === 'object' && JSON.stringify(placement).length < 4096,
            'Choose a valid placement.',
          )
          controller.signal.throwIfAborted()
          for (const page of pages) s.edits.set(page.index, page)
          s.proposal = { placement: placement as OcrPlacement, pages, turn: input.turnId }
          return answer({
            session: s.id,
            placement,
            reason: input.placement ? 'user-requested' : recommendation.reason,
            texts: pages.slice(0, 20).map((p) => ({
              index: p.index,
              text: plain(p.payload).slice(0, 2000),
              totalCharacters: plain(p.payload).length,
              truncated: plain(p.payload).length > 2000,
            })),
            needsConfirmation: true,
            next: 'Explain the location and reason, show the reviewed text, and ask the person to confirm or change it. Do not apply on this turn.',
          })
        } finally {
          s.busy = false
        }
      }
      if (input.action === 'apply') {
        requireThat(s.proposal, 'Propose and discuss a destination before applying OCR.')
        requireThat(
          input.turnId !== s.proposal.turn,
          'Wait for explicit confirmation from the person on a later human turn.',
        )
        s.busy = true
        try {
          controller.signal.throwIfAborted()
          const output = await deps.ocr.write(
            s.prepared.token,
            s.proposal.pages,
            s.proposal.placement,
          )
          sessions.delete(s.id)
          return answer(
            {
              outputPath: output.outputPath,
              sourceUnchanged: true,
              format: prepared.format,
              next: 'Report the actual output file. The original file was not modified.',
            },
            { display: { kind: 'links', items: [{ url: output.outputPath, title: s.file }] } },
          )
        } finally {
          s.busy = false
        }
      }
      throw new Refusal('Unknown OCR action.')
    } catch (err) {
      const message =
        err instanceof Refusal
          ? err.message
          : controller.signal.aborted
            ? 'OCR was stopped; no output was applied.'
            : 'The OCR step failed. No successful change was confirmed. Review the connection, source file or destination before retrying.'
      return answer({ error: message }, { isError: true })
    } finally {
      active.delete(requestKey)
    }
  }
  return {
    execute,
    forget(owner: number) {
      for (const entry of active.values()) if (entry.owner === owner) entry.controller.abort()
      for (const s of sessions.values()) if (s.owner === owner) release(s)
      deps.ocr.forgetOwner(owner)
    },
  }
}
export type OcrChatService = ReturnType<typeof createOcrChatService>
