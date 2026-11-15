import type { ChatOcrAnswer, ChatOcrRequest } from '@genoffice/project-store/folder-api'
import type { OcrService } from './ocr'
import type { OcrPageResult, OcrPlacement, OcrPrepared } from '../../shared/translate-ocr'
import type { OcrPopupResult } from '../../shared/ocr-popup'
import { readAiPage } from '../../../../../packages/pdf-structure/src/ai-read/read-page'
import type { AiReadRequest } from '../../../../../packages/pdf-structure/src/ai-read/instruction'
import { resolveOcrSelection } from '../../shared/translate-ocr'
import { TranslateIpcError } from '../../shared/translate-api'
import { checkOcrBoxesPayload, readOcrBoxes } from '../../shared/ocr-boxes'
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
/** How the OCR selection popup ended, as the chat tool hears of it. */
export type OcrChatPopupOutcome =
  | { kind: 'result'; result: OcrPopupResult }
  | { kind: 'closed' }
  | { kind: 'already-open' }
  | { kind: 'unavailable' }
/**
 * The OCR selection popup over the asking window. It shows the pictures with local previews,
 * takes the person's confirmation to start, reads them and answers with their text. `signal`
 * closes it when the run is cancelled.
 */
export interface OcrChatPopup {
  ask(
    owner: number,
    target: { dir: string; file: string },
    signal: AbortSignal,
  ): Promise<OcrChatPopupOutcome>
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
  /** absent where no overlay can be shown: `choose` then points to list and read */
  popup?: OcrChatPopup
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
  /** `placement` is absent when the text goes into a new Word document */
  proposal?: {
    placement?: OcrPlacement
    /** the placements the person may choose between: the proposed one and the alternatives */
    offered: OcrPlacement[]
    pages: OcrPageResult[]
    turn: string
  }
}
class Refusal extends Error {}

/** The formats chat OCR takes. A Word or Excel file gets the text placed in it; the others get a new Word document. */
const CHAT_FORMATS = /\.(docx|xlsx|hwpx|hwp|pdf)$/i
const OLD_WORD = /\.doc$/i
export const OLD_WORD_MESSAGE =
  'An old .doc file cannot be read. Ask the person to open it in Word, save it as .docx, and add that file. No format conversion was performed.'
/**
 * A PDF read page by page and the pictures of a Hangul document end in a new Word document next
 * to the original: there is no placement to recommend, choose or confirm.
 */
const intoNewDocument = (prepared: OcrPrepared): boolean =>
  prepared.kind === 'pdf' || prepared.kind === 'extracted'
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
/** a Word picture whose text can go back over it as boxes */
const takesBoxes = (prepared: OcrPrepared, index: number): boolean =>
  prepared.kind === 'embedded' &&
  prepared.format === 'docx' &&
  prepared.items[index - 1]?.boxable === true

/** Texts that name a place on the PC are never passed on. */
const PATH_LIKE = /[A-Za-z]:[\\/][^\s'"]*|(?:\/[^\s'"/]+){2,}/g

/**
 * What the model and the person are told when a step failed. A reason the app itself gave (a
 * refused placement, an expired run, a changed source) is passed on with its code, because it
 * says what to do next. Anything else, a system error included, stays general and names only the
 * step: such a text can carry a path or other things that are not for the chat.
 */
function failureMessage(action: string, err: unknown): string {
  const nothing = action === 'apply' ? ' No document was written.' : ' Nothing was changed.'
  if (err instanceof TranslateIpcError && err.code !== 'UNKNOWN')
    return `The OCR step (${action}) failed: ${err.message.replace(PATH_LIKE, '<path>')}.${nothing}`
  return `The OCR step (${action}) failed. No successful change was confirmed. Review the connection, source file or destination before retrying.`
}

/** JSON with the keys in order, so two placements that say the same thing compare equal */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** A reading made of plain text: one paragraph per blank-line separated block. */
function textPayload(text: string) {
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
  return {
    version: 1,
    blocks: blocks.map((block) => ({
      kind: 'paragraph',
      runs: [{ kind: 'text', text: block }],
    })),
    footnotes: [],
    droppedRepetitions: 0,
    reasked: false,
  }
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
        requireThat(!OLD_WORD.test(source.file), OLD_WORD_MESSAGE)
        requireThat(
          CHAT_FORMATS.test(source.file),
          'Conversational OCR supports DOCX, XLSX, HWPX, HWP and PDF. No format conversion was performed.',
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
        if (!(
          (prepared.kind === 'embedded' ||
            prepared.kind === 'extracted' ||
            prepared.kind === 'pdf') &&
          prepared.ocr.kind === 'ai'
        )) {
          await deps.ocr.release(prepared.token).catch(() => undefined)
          throw new Refusal('OCR is not enabled for this document.')
        }
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
          ...(intoNewDocument(prepared) ? { result: 'new-docx' } : {}),
          next:
            prepared.kind === 'pdf'
              ? 'Ask in chat: all pages or selected pages? No page has been sent and no document changed.'
              : 'Ask in chat: all images or selected images? No image has been sent and no document changed.',
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
                title: `${item.index}. ${item.name}${item.page ? ` · p.${item.page}${item.pageApprox ? '+' : ''}` : ''} · ${item.location ?? ''}`,
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
      if (input.action === 'choose') {
        requireThat(
          deps.popup,
          'The selection popup is not available here. Choose pictures in the chat with list and read instead.',
        )
        s.busy = true
        try {
          const outcome = await deps.popup.ask(
            owner,
            { dir: s.dir, file: s.file },
            controller.signal,
          )
          controller.signal.throwIfAborted()
          if (outcome.kind === 'unavailable')
            throw new Refusal(
              'The selection popup could not be shown. Choose pictures in the chat with list and read instead.',
            )
          if (outcome.kind === 'already-open')
            return answer({
              session: s.id,
              alreadyOpen: true,
              next: 'The selection popup is already open. Do not open another; wait for the person to finish or close it.',
            })
          if (outcome.kind === 'closed')
            return answer({
              session: s.id,
              closed: true,
              next: 'The person closed the popup without reading anything. Nothing was sent. Ask what they want to do next.',
            })
          const count = s.prepared.items.length
          const kept = outcome.result.pages.filter(
            (page) =>
              Number.isInteger(page.index) &&
              page.index >= 1 &&
              page.index <= count &&
              page.text.trim() !== '',
          )
          const unread = outcome.result.unread ?? []
          if (kept.length === 0)
            return answer({
              session: s.id,
              recognised: [],
              unread,
              next: 'The popup finished but no picture gave text. Tell the person which pictures were empty or failed and ask what to do.',
            })
          // the popup read with a lease of its own; the session takes a fresh one for what was read
          const indices = kept.map((page) => page.index).sort((a, b) => a - b)
          await deps.ocr.release(s.prepared.token).catch(() => undefined)
          s.prepared = await deps.ocr.prepare(s.dir, [s.file], owner)
          await deps.ocr.start(s.prepared.token, indices)
          s.allowed = new Set(indices)
          for (const page of kept)
            s.pages.set(page.index, {
              index: page.index,
              // a reading with places keeps them; the boxes were checked when the popup answered
              payload:
                page.boxes && page.boxes.length > 0 && takesBoxes(s.prepared, page.index)
                  ? { kind: 'boxes', boxes: page.boxes, text: page.text }
                  : textPayload(page.text),
            })
          s.edits.clear()
          s.proposal = undefined
          requireThat(
            JSON.stringify([...s.pages.values()]).length <= 8 * 1024 * 1024,
            'OCR session text limit reached. Review the recognised images before continuing.',
          )
          const items = s.prepared.items
          return answer({
            session: s.id,
            file: s.file,
            recognised: indices,
            unread: unread.map((u) => ({
              index: u.index,
              page: items[u.index - 1]?.page,
              location: items[u.index - 1]?.location,
              reason: u.reason,
            })),
            results: indices.slice(-20).map((index) => {
              const text = plain(s.pages.get(index)!.payload)
              return {
                index,
                page: items[index - 1]?.page,
                location: items[index - 1]?.location,
                text: text.slice(0, 2000),
                totalCharacters: text.length,
                truncated: text.length > 2000,
              }
            }),
            next: 'The person chose and confirmed these pictures in the popup, and they were read. Review the OCR text with the person in chat (review gives longer text in chunks), then call propose.',
          })
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
              // pictures inside a document: the text in drawings counts; a PDF page is a page
              const asked = (
                request: Parameters<typeof asPictureRequest>[0],
                signal: AbortSignal,
              ): Promise<string> =>
                deps.ask(
                  route,
                  s.prepared.kind === 'pdf' ? request : asPictureRequest(request),
                  signal,
                  owner,
                )
              if (takesBoxes(s.prepared, index)) {
                // where each text stands, so the text can be put back over the picture
                const boxes = await readOcrBoxes({
                  image: image.data,
                  mime: image.mime,
                  signal: controller.signal,
                  ask: asked,
                })
                s.pages.set(index, { index, payload: boxes })
              } else {
                const reading = await readAiPage({
                  page: index,
                  pageFingerprint: '',
                  image: image.data,
                  mime: image.mime,
                  signal: controller.signal,
                  ask: asked,
                })
                s.pages.set(index, { index, payload: reading.payload })
              }
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
              page: prepared.items[index - 1]?.page,
              location: prepared.items[index - 1]?.location,
              text: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).slice(0, 2000),
              totalCharacters: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).length,
              truncated: plain((s.edits.get(index) ?? s.pages.get(index))!.payload).length > 2000,
            })),
            next: remaining.length
              ? 'Continue only within the scope the person already requested. Each read call processes at most 20 new images.'
              : intoNewDocument(prepared)
                ? 'Review the OCR text in chat, then call propose. It goes into a new Word document. No output file exists yet.'
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
          if (intoNewDocument(s.prepared)) {
            // no placement: a placement the model made up is ignored
            controller.signal.throwIfAborted()
            for (const page of pages) s.edits.set(page.index, page)
            s.proposal = { offered: [], pages, turn: input.turnId }
            return answer({
              session: s.id,
              result: 'new-docx',
              texts: pages.slice(0, 20).map((p) => ({
                index: p.index,
                text: plain(p.payload).slice(0, 2000),
                totalCharacters: plain(p.payload).length,
                truncated: plain(p.payload).length > 2000,
              })),
              needsConfirmation: true,
              next: 'Show the reviewed text and say it will be written into a new Word document next to the original, which is not changed. Ask the person to confirm. Do not apply on this turn.',
            })
          }
          const recommendation = await deps.ocr.recommend(
            s.prepared.token,
            pages.map((p) => p.index),
          )
          // text boxes over the pictures that gave places, unless the person chose another way
          const boxed = pages.flatMap((p) => {
            const payload = checkOcrBoxesPayload(p.payload)
            return payload && payload.boxes.length > 0
              ? [{ index: p.index, boxes: payload.boxes }]
              : []
          })
          const onPicture = !input.placement && s.prepared.format === 'docx' && boxed.length > 0
          const placement =
            input.placement ??
            (onPicture ? { kind: 'docx-image-boxes', images: boxed } : recommendation.placement)
          requireThat(
            placement && typeof placement === 'object' && JSON.stringify(placement).length < 262144,
            'Choose a valid placement.',
          )
          controller.signal.throwIfAborted()
          for (const page of pages) s.edits.set(page.index, page)
          // the other ways a Word document can take the text; the person chooses among these
          const alternatives =
            s.prepared.format === 'docx'
              ? [
                  recommendation.placement,
                  { kind: 'docx-after-images' },
                  { kind: 'docx-end' },
                ].filter(
                  (candidate, at, all) =>
                    candidate &&
                    canonical(candidate) !== canonical(placement) &&
                    all.findIndex((other) => canonical(other) === canonical(candidate)) === at,
                )
              : []
          s.proposal = {
            placement: placement as OcrPlacement,
            offered: [placement as OcrPlacement, ...(alternatives as OcrPlacement[])],
            pages,
            turn: input.turnId,
          }
          return answer({
            session: s.id,
            placement,
            reason: input.placement
              ? 'user-requested'
              : onPicture
                ? 'on-picture'
                : recommendation.reason,
            // the ways that are not proposed first stay open to the person
            ...(alternatives.length > 0 ? { alternatives } : {}),
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
          let placement = s.proposal.placement
          if (placement && input.placement !== undefined) {
            // the way the person chose: only one that was offered, never one made up at apply
            const chosen = s.proposal.offered.find(
              (offered) => canonical(offered) === canonical(input.placement),
            )
            requireThat(
              chosen,
              'That placement was not proposed. Call propose with it and wait for the person to confirm it.',
            )
            placement = chosen
          }
          const output = placement
            ? await deps.ocr.write(s.prepared.token, s.proposal.pages, placement)
            : await deps.ocr.write(s.prepared.token, s.proposal.pages)
          sessions.delete(s.id)
          return answer(
            {
              outputPath: output.outputPath,
              sourceUnchanged: true,
              format: prepared.format ?? 'docx',
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
      if (!(err instanceof Refusal) && !controller.signal.aborted)
        console.warn('[document_ocr] step failed:', input.action, err)
      const message =
        err instanceof Refusal
          ? err.message
          : controller.signal.aborted
            ? 'OCR was stopped; no output was applied.'
            : failureMessage(input.action, err)
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
