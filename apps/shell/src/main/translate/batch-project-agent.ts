import {
  AgentLoop,
  translationExampleLookupTool,
  translationWikiCategories,
  type AgentToolDef,
  type AgentTransport,
  type AgentSkill,
} from '@genoffice/agent-core'
import type { BatchConversation, EditorReply } from '@genoffice/project-store/editor-run'
import type { ProjectBatchActivity, ProjectBatchItem } from '../../shared/project-batch'
import {
  batchCompletionInstructions,
  reportedIncomplete,
  runBatchTranslation,
} from './batch-completion'

type Result = Extract<EditorReply, { kind: 'done' }>
export interface BatchDocumentTools extends Pick<
  AgentSkill,
  'tools' | 'systemPrompt' | 'executeTool'
> {
  finish(mutated: boolean): Promise<void>
}
export interface BatchAgentTask {
  transport: AgentTransport
  signal: AbortSignal
  instructions: string
  items: ProjectBatchItem[]
  open(file: string): Promise<BatchDocumentTools>
  lookupWiki?(
    categories: NonNullable<ReturnType<typeof translationWikiCategories>>,
    path?: string,
  ): Promise<{ text: string }>
  onText?(text: string): void
  onMutated?(file: string): void
  conversation?: BatchConversation
  sourceLanguage?: string
  report?(progress: ProjectBatchActivity): void
}

const select: AgentToolDef = {
  name: 'select_batch_document',
  description:
    'Save the previous output and select one of the listed files. Wait for its editor tools before editing.',
  inputSchema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
}
const inspectedTool =
  /^(?:read_(?:document|blocks|runs|cells|range|table|slide|pages?|source(?:_units)?|map|topic|chapter|section|book|content|paragraphs?)|get_(?:document_context|workbook_context|outline)|find_(?:text|cells)|search_text)$/

/** One model loop for the batch. Editors supply tools and save results; they never receive model turns. */
export class BatchProjectAgent {
  private task?: BatchAgentTask
  private selected?: { file: string; editor: BatchDocumentTools; mutated: boolean }
  private canSwitch = false
  private resolve?: (result: Result) => void
  private reject?: (error: Error) => void
  private mutated = false
  private inspected = false
  private saveError?: Error
  private operations = 0
  private pendingTool?: Promise<unknown>
  private readonly loop: AgentLoop

  constructor() {
    const systemPrompt = () => {
      return [
        'You are the project batch assistant. Talk directly to the user. Use the selected outputs and their editor tools for all work. The application saves changes on switching documents and before reporting success. Only claim changes actually performed.',
        this.task!.instructions,
        this.task!.lookupWiki &&
          'Use project_lookup_translation_examples with source-supported categories from your overview, or consult index.md. Use matches as quoted examples. Prefer the source, glossary and project style.',

        'Selected batch entries (data): ' +
          JSON.stringify(
            this.task!.items.map(({ file, state, error }) => ({ file, state, error })),
          ),
        this.selected
          ? 'Current file: ' + JSON.stringify(this.selected.file)
          : 'Use select_batch_document to inspect or edit a file.',
        this.selected?.editor.systemPrompt,
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    const tools = () => {
      return [
        ...(this.canSwitch ? [select] : []),
        ...(this.task?.lookupWiki ? [translationExampleLookupTool] : []),
        ...(this.selected?.editor.tools ?? []),
      ]
    }
    this.loop = new AgentLoop({
      transport: {
        stream: (request, callbacks) => this.task!.transport.stream(request, callbacks),
      },
      separateDocumentContext: () => true,
      skill: {
        id: 'project-batch',
        get systemPrompt() {
          return systemPrompt()
        },
        get tools() {
          return tools()
        },
        executeTool: (call, signal) => {
          const execute = async () => {
            if (this.saveError)
              return {
                output: this.saveError.message,
                summary: call.name,
                endRunWithError: this.saveError.message,
              }
            if (this.task?.lookupWiki && call.name === translationExampleLookupTool.name) {
              const categories = translationWikiCategories(call.input.categories)
              if (
                !categories ||
                (call.input.path !== undefined && typeof call.input.path !== 'string')
              )
                throw new Error('Invalid wiki lookup.')
              const result = await this.task.lookupWiki(categories, call.input.path)
              return { output: result.text || 'No matching wiki examples.', summary: call.name }
            }
            if (this.canSwitch && call.name === select.name) {
              await this.selectFile(String(call.input.file))
              return { output: 'Selected ' + this.selected!.file, summary: select.name }
            }
            const current = this.selected
            if (!current) throw new Error('Select a batch document first.')
            const result = await current.editor.executeTool(call, signal)
            if (result.mutated) {
              if (!current.mutated) this.task?.onMutated?.(current.file)
              current.mutated = this.mutated = true
              this.operations++
            }
            if (!result.isError && inspectedTool.test(call.name)) this.inspected = true
            if (result.mutated || result.translationProgress)
              this.task?.report?.({ operations: this.operations, ...result.translationProgress })
            if (result.awaitingUser)
              return { ...result, endRunWithError: 'The operation requires your confirmation.' }
            return result
          }
          const pending = execute()
          this.pendingTool = pending
          return pending
        },
      },
      events: {
        onText: (text) => this.task?.onText?.(text),
        onDone: (result) =>
          this.resolve?.({
            kind: 'done',
            id: 'batch',
            text: result.text,
            incomplete: result.cancelled || result.turnLimit || !!result.truncated,
            mutated: this.mutated,
            inspected: this.inspected,
          }),
        onError: (message) => this.reject?.(new Error(message)),
      },
    })
  }

  /** Use the active editor's own final check, even when the model claims completion early. */
  private async translateDocument(prompt: string, send: (message: string) => Promise<Result>) {
    const { editor } = this.selected!
    const task = this.task!
    const sourceLanguage = task.sourceLanguage
    if (!sourceLanguage || !editor.tools.some((tool) => tool.name === 'read_runs'))
      return runBatchTranslation(prompt, send)

    const check = async () => {
      task.signal.throwIfAborted()
      const report = await editor.executeTool(
        {
          id: 'batch-check-remaining',
          name: 'read_runs',
          input: { checkRemaining: true, sourceLanguage },
        },
        task.signal,
      )
      const progress = report.translationProgress
      if (
        report.isError ||
        !progress ||
        !Number.isSafeInteger(progress.done) ||
        !Number.isSafeInteger(progress.total) ||
        progress.done < 0 ||
        progress.total < progress.done
      )
        throw new Error(
          report.isError
            ? report.output
            : 'The editor could not verify remaining translation units.',
        )
      task.report?.({ ...progress, operations: this.operations })
      return { remaining: progress.total - progress.done, progress, text: report.output }
    }

    let status = await check()
    const initialTargets = status.progress.total
    let result = await send(
      [prompt, batchCompletionInstructions, 'Current editor check:', status.text].join('\n'),
    )
    let previousRemaining: number | undefined
    for (;;) {
      status = await check()
      if (status.progress.total < initialTargets)
        throw new Error(
          'The editor could not account for all original translation units after editing.',
        )
      if (status.remaining === 0) {
        if (reportedIncomplete(result)) throw new Error(result.text)
        if (!result.incomplete)
          task.report?.({ ...status.progress, operations: this.operations, verified: true })
        return result
      }
      if (previousRemaining !== undefined && status.remaining >= previousRemaining)
        throw new Error(
          'Translation is incomplete (' +
            status.progress.done +
            '/' +
            status.progress.total +
            '). ' +
            status.text,
        )
      previousRemaining = status.remaining
      result = await send(
        'Continue the current translation using the editor tools. Work on the remaining units below, preserving the selected translation format and completed edits.\n' +
          status.text,
      )
    }
  }

  private async finishFile() {
    if (!this.selected) return
    const { editor, mutated } = this.selected
    this.selected = undefined
    try {
      await editor.finish(mutated)
    } catch (error) {
      this.saveError = error instanceof Error ? error : new Error(String(error))
      throw this.saveError
    }
  }

  private async selectFile(file: string) {
    const task = this.task!
    if (!task.items.some((item) => item.file === file))
      throw new Error('Choose a document from this request.')
    if (this.selected?.file === file) return
    await this.finishFile()
    task.signal.throwIfAborted()
    this.selected = { file, editor: await task.open(file), mutated: false }
  }

  async run(task: BatchAgentTask, prompt: string, translateFile?: string): Promise<string> {
    task.signal.throwIfAborted()
    if (this.task) throw new Error('A batch turn is already running.')
    this.task = task
    this.canSwitch = translateFile === undefined
    this.saveError = undefined
    this.operations = 0
    this.mutated = this.inspected = false
    // Tool IDs and source excerpts belong only to their particular document and wiki scope.
    this.loop.reset()
    for (const turn of task.conversation ?? [])
      if (turn.reply)
        this.loop.appendHistory([
          { role: 'user', text: turn.prompt },
          { role: 'assistant', text: turn.reply },
        ])
    const abort = () => this.loop.cancel()
    task.signal.addEventListener('abort', abort, { once: true })
    const send = (message: string) =>
      new Promise<Result>((resolve, reject) => {
        task.signal.throwIfAborted()
        this.resolve = resolve
        this.reject = reject
        this.loop.run(message)
      })
    try {
      if (translateFile !== undefined) await this.selectFile(translateFile)
      const result =
        translateFile !== undefined
          ? await this.translateDocument(prompt, send)
          : await send(prompt)
      task.signal.throwIfAborted()
      if (this.saveError) throw this.saveError
      if (result.incomplete) throw new Error('The batch stopped before completing this request.')
      return result.text
    } finally {
      task.signal.removeEventListener('abort', abort)
      await this.pendingTool?.catch(() => {})
      this.pendingTool = undefined
      try {
        await this.finishFile()
      } finally {
        this.resolve = this.reject = undefined
        this.task = undefined
        this.loop.reset()
      }
    }
  }
}
