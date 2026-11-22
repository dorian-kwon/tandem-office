import { randomUUID } from 'node:crypto'
import type {
  BatchConversation,
  BatchTranslationChoices,
} from '@genoffice/project-store/editor-run'
import type {
  ProjectBatchActivity,
  ProjectBatchItem,
  ProjectBatchMessage,
  ProjectBatchSend,
  ProjectBatchSnapshot,
} from '../../shared/project-batch'
import { TranslateIpcError } from '../../shared/translate-api'

export interface ProjectBatchEditorRequest {
  choices?: BatchTranslationChoices
  useWiki?: boolean
  dir: string
  file: string
  outputPath: string
  sourceLang: string
  targetLang: string
  signal: AbortSignal
  report: (update: ProjectBatchActivity) => void
}

type Translate = (
  file: string,
  signal: AbortSignal,
  progress: ProjectBatchEditorRequest['report'],
) => Promise<string | void>

export type { BatchConversation } from '@genoffice/project-store/editor-run'
type Deliver = (
  item: ProjectBatchItem,
  prompt: string,
  conversation: BatchConversation,
  signal: AbortSignal,
) => Promise<string>

/** Keep the last few exchanges as separately labeled background for references like
 * "do that here too". The current user turn never gets abbreviated or rewritten. */
function conversationBefore(
  messages: ProjectBatchMessage[],
  current: ProjectBatchMessage,
  file: string,
): BatchConversation {
  return messages
    .slice(0, messages.indexOf(current))
    .slice(-4)
    .map((message) => {
      const answered =
        message.targets.find((t) => t.file === file && t.state === 'done' && t.reply) ??
        message.targets.find((t) => t.state === 'done' && t.reply)
      return {
        prompt: message.prompt.slice(0, 2000),
        ...(answered ? { file: answered.file, reply: answered.reply!.slice(0, 2000) } : {}),
      }
    })
}

/** A single editor works at a time, including its save and teardown. */
export class ProjectBatchQueue {
  private active?: { dir: string; controller: AbortController; owner: number }
  private readonly projects = new Map<string, ProjectBatchSnapshot>()

  private readonly deliveries = new WeakMap<ProjectBatchMessage, Deliver>()

  constructor(private readonly changed: (value: ProjectBatchSnapshot) => void) {}

  busy(dir: string): boolean {
    return this.active?.dir === dir
  }

  status(dir: string): ProjectBatchSnapshot | null {
    const state = this.projects.get(dir)
    return state ? structuredClone(state) : null
  }

  forget(dir: string): void {
    if (!this.busy(dir)) this.projects.delete(dir)
  }

  stopOwner(owner: number): void {
    if (this.active?.owner === owner) this.stop(this.active.dir)
  }

  stop(dir: string): void {
    if (!this.active || this.active.dir !== dir) return
    const state = this.projects.get(dir)!
    state.stopping = true
    this.active.controller.abort()
    this.emit(state)
  }

  send(args: ProjectBatchSend, owner: number, deliver: Deliver): ProjectBatchSnapshot {
    const state = this.projects.get(args.dir)
    if (
      !state ||
      state.id !== args.batchId ||
      !state.id ||
      state.stopping ||
      (this.active && this.active.dir !== args.dir)
    )
      throw new TranslateIpcError('TRANSLATE_BUSY', 'This batch is no longer available.')
    if (
      typeof args.prompt !== 'string' ||
      !args.prompt.trim() ||
      !Array.isArray(args.files) ||
      !args.files.length ||
      args.files.length > state.items.length
    )
      throw new TranslateIpcError('INVALID_ARGUMENT', 'Choose documents and enter a message.')
    const included = new Set(state.items.map((item) => item.file))
    if (args.files.some((file) => !included.has(file)))
      throw new TranslateIpcError('INVALID_ARGUMENT', 'Unknown batch document.')
    const message: ProjectBatchMessage = {
      id: randomUUID(),
      prompt: args.prompt,
      targets: [...new Set(args.files)].map((file) => ({ file, state: 'queued' })),
    }
    ;(state.messages ??= []).push(message)
    this.deliveries.set(message, deliver)
    if (!this.active) {
      const controller = new AbortController()
      this.active = { dir: args.dir, controller, owner }
      state.running = true
      void this.run(state, controller.signal, new Set())
    }
    this.emit(state)
    return this.status(args.dir)!
  }

  start(
    dir: string,
    files: string[],
    owner: number,
    run: (
      file: string,
      signal: AbortSignal,
      progress: ProjectBatchEditorRequest['report'],
    ) => Promise<string | void>,
    retry: boolean,
  ): ProjectBatchSnapshot {
    if (this.active)
      throw new TranslateIpcError('TRANSLATE_BUSY', 'A project translation is already running.')
    const wanted = new Set(files)
    const prior = retry ? this.projects.get(dir) : undefined
    const previous = prior?.items
    if (retry) {
      const unfinished = new Set(
        previous
          ?.filter((item) => item.state === 'failed' || item.state === 'stopped')
          .map((item) => item.file),
      )
      for (const file of wanted) if (!unfinished.has(file)) wanted.delete(file)
      if (!wanted.size)
        throw new TranslateIpcError(
          'INVALID_ARGUMENT',
          'There are no unfinished documents to retry.',
        )
    }
    const items: ProjectBatchItem[] = previous
      ? previous.map((item) =>
          wanted.has(item.file) ? { file: item.file, state: 'waiting' } : item,
        )
      : []
    const kept = new Set(items.map((item) => item.file))
    for (const file of wanted) if (!kept.has(file)) items.push({ file, state: 'waiting' })
    const state: ProjectBatchSnapshot = {
      id: randomUUID(),
      dir,
      running: true,
      stopping: false,
      items,
      ...(prior?.messages ? { messages: prior.messages } : {}),
    }
    const controller = new AbortController()
    this.active = { dir, controller, owner }
    this.projects.set(dir, state)
    void this.run(state, controller.signal, wanted, run)
    return this.status(dir)!
  }

  private emit(state: ProjectBatchSnapshot): void {
    this.changed(state)
  }

  private async run(
    state: ProjectBatchSnapshot,
    signal: AbortSignal,
    wanted: Set<string>,
    run?: Translate,
  ): Promise<void> {
    try {
      // One scheduler owns editing, saving and closing. Take a queued human turn
      // as soon as its selected output is available, including already saved files.
      const itemsByFile = new Map(state.items.map((item) => [item.file, item]))
      const ready = (t: ProjectBatchMessage['targets'][number]) => {
        const item = itemsByFile.get(t.file)
        return t.state === 'queued' && item && item.state !== 'waiting' && item.state !== 'running'
      }
      while (!signal.aborted) {
        const messages = state.messages ?? []
        const message = messages.find((m) => m.targets.some(ready))
        if (message) {
          const target = message.targets.find(ready)!
          const item = itemsByFile.get(target.file)!
          const deliver = this.deliveries.get(message)!
          target.state = 'running'
          this.emit(state)
          try {
            const reply = await deliver(
              item,
              message.prompt,
              conversationBefore(messages, message, item.file),
              signal,
            )
            signal.throwIfAborted()
            target.reply = reply
            target.state = 'done'
          } catch (error) {
            target.state = signal.aborted ? 'stopped' : 'failed'
            if (!signal.aborted)
              target.error = String(error instanceof Error ? error.message : error).slice(0, 320)
          }
          this.emit(state)
          continue
        }
        const item = state.items.find((i) => i.state === 'waiting' && wanted.has(i.file))
        if (!item || !run) break
        item.state = 'running'
        item.phase = 'opening'
        this.emit(state)
        let lastUpdate = 0
        let pending: ReturnType<typeof setTimeout> | undefined
        const flush = () => {
          clearTimeout(pending)
          pending = undefined
          lastUpdate = Date.now()
          this.emit(state)
        }
        try {
          const output = await run(item.file, signal, ({ phase, operations, done, total }) => {
            if (item.state !== 'running' || signal.aborted) return
            const changedPhase = phase !== undefined && phase !== item.phase
            if (changedPhase) {
              // Page recognition and text translation use different units.
              if (item.phase === 'ocr') {
                delete item.done
                delete item.total
              }
              item.phase = phase
            }
            if (operations !== undefined && Number.isSafeInteger(operations) && operations >= 0) {
              item.operations = Math.max(item.operations ?? 0, operations)
              // An ordinary edit may invalidate the earlier unit count.
              if (done === undefined || total === undefined) {
                delete item.done
                delete item.total
              }
            }
            if (
              total !== undefined &&
              done !== undefined &&
              Number.isSafeInteger(total) &&
              total > 0 &&
              Number.isSafeInteger(done) &&
              done >= 0
            ) {
              item.done = Math.min(done, total)
              item.total = total
            }
            const remaining = 250 - (Date.now() - lastUpdate)
            if (changedPhase || remaining <= 0) flush()
            else pending ??= setTimeout(flush, remaining)
          })
          if (output) item.output = output
          item.state = 'saved'
        } catch (err) {
          item.state = signal.aborted ? 'stopped' : 'failed'
          if (!signal.aborted)
            item.error = String(err instanceof Error ? err.message : err).slice(0, 320)
        } finally {
          clearTimeout(pending)
        }
      }
    } finally {
      for (const item of state.items) if (item.state === 'waiting') item.state = 'stopped'
      for (const message of state.messages ?? [])
        for (const target of message.targets)
          if (target.state === 'queued') target.state = 'stopped'
      this.active = undefined
      state.running = false
      state.stopping = false
      this.emit(state)
    }
  }
}
