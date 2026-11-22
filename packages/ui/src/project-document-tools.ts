import {
  documentTranslationSkill,
  translationWorkflowTools,
  type DocumentTranslationHost,
  type AgentSkill,
  type AgentToolCall,
  type AgentToolDef,
  type ToolExecution,
} from '@genoffice/agent-core'

const namesByEditor = {
  docs: [
    'get_document_context',
    'read_blocks',
    'replace_blocks',
    'read_runs',
    'translate_blocks',
    'add_bilingual',
    'revise_blocks',
  ],
  sheets: ['get_workbook_context', 'read_cells', 'read_range', 'find_cells', 'propose_operations'],
  slides: ['read_slide', 'apply_ops'],
  hwp: [
    'read_document',
    'find_text',
    'list_tables',
    'read_table',
    'list_fields',
    'list_notes',
    'replace_text',
    'replace_all',
    'fill_cells',
    'fill_field',
    'edit_note',
  ],
  pdf: ['get_outline', 'read_pages', 'search_text', 'edit_text', 'edit_block', 'insert_text'],
  markdown: [
    'get_document_context',
    'read_blocks',
    'apply_ops',
    'read_source_units',
    'translate_source_units',
  ],
  html: ['get_outline', 'read_source', 'apply_ops'],
  epub: ['read_book', 'read_chapter', 'find_text', 'edit_blocks'],
  mindmap: ['read_map', 'read_topic', 'edit_map'],
} as const
export type DocumentToolEditor = keyof typeof namesByEditor

const operations = {
  sheets: { tool: 'propose_operations', field: 'operations', names: ['set_cell', 'set_range'] },
  slides: { tool: 'apply_ops', field: 'ops', names: ['setText', 'setTableCell', 'setNotes'] },
  markdown: { tool: 'apply_ops', field: 'ops', names: ['replaceBlocks', 'replaceText'] },
  html: { tool: 'apply_ops', field: 'ops', names: ['set_text', 'str_replace'] },
  epub: { tool: 'edit_blocks', field: 'ops', names: ['replace', 'insert_after'] },
  mindmap: { tool: 'edit_map', field: 'edits', names: ['set_title', 'set_note', 'set_labels'] },
}
const contextTool: AgentToolDef = {
  name: 'read_current_editor_context',
  description:
    'Read the current document outline and editor context before addressing its pages, cells or blocks.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

/** Use only the native document skill. Composed provider, search and file skills
 * never enter this capability, including when a provider/plugin adds new tools. */
export function nativeDocumentTools(
  editor: DocumentToolEditor,
  skill: AgentSkill,
  host?: DocumentTranslationHost,
) {
  const allowed = new Set<string>(namesByEditor[editor])
  const tools = skill.tools.filter((t) => allowed.has(t.name))
  const workflow = host ? documentTranslationSkill({ ...skill, tools }, host).skill : null
  const workflowNames = new Set(translationWorkflowTools.map((t) => t.name))
  const ops = editor in operations ? operations[editor as keyof typeof operations] : undefined
  return {
    tools: [contextTool, ...tools, ...(workflow ? translationWorkflowTools : [])],
    systemPrompt:
      'These tools act on the current ' +
      editor +
      ' document. Read the source before translating and keep its structure. For a whole-document translation call prepare_document_translation, survey and read representative passages, record_source_overview with verbatim evidence, then use translation_batch_context between batches. Use read_current_editor_context for the current outline. ' +
      (ops
        ? 'For ' +
          ops.tool +
          ' only these translation operations are available: ' +
          ops.names.join(', ') +
          '. '
        : '') +
      (editor === 'docs'
        ? 'Read read_runs, then use translate_blocks for replacement, add_bilingual to keep both languages, and revise_blocks for revisions.'
        : ''),
    async executeTool(call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> {
      const fail = (output: string) => ({ output, isError: true, summary: call.name })
      signal?.throwIfAborted()
      if (call.name === contextTool.name)
        return {
          summary: 'Document context',
          output: skill.buildContext?.() || 'Read the current document with its listed read tools.',
        }
      if (workflowNames.has(call.name)) {
        if (!workflow?.tools.some((t) => t.name === call.name))
          return fail(
            'This translation workflow step is not currently available. Start preparation, read representative passages, then record the overview.',
          )
        return workflow.executeTool(call, signal)
      }
      if (!allowed.has(call.name) || !tools.some((t) => t.name === call.name))
        return fail('Unknown document translation tool.')
      if (workflow && !workflow.tools.some((t) => t.name === call.name))
        return fail(
          'Read representative source passages and record the source overview before editing.',
        )
      let input = call.input
      if (
        call.name === 'replace_blocks' &&
        (input.startBlockIndex !== input.endBlockIndex ||
          typeof input.html !== 'string' ||
          !/^<p>[^<>]*<\/p>$/u.test(input.html))
      )
        return fail(
          'For a plain paragraph rewrite provide one block and one plain <p>text</p>. For formatted translation use read_runs and translate_blocks.',
        )

      if (ops && call.name === ops.tool) {
        const items = input[ops.field]
        if (
          !Array.isArray(items) ||
          !items.length ||
          items.some((v) => !v || !ops.names.includes(v.op))
        )
          return fail('Use only these translation operations: ' + ops.names.join(', ') + '.')
        if (
          editor === 'html' &&
          items.some(
            (v) => v.op === 'str_replace' && (/[<>]/.test(v.new) || /attachment:\/\//i.test(v.new)),
          )
        )
          return fail('Use plain text for translated passages.')
        input =
          editor === 'slides' || editor === 'sheets'
            ? { ...input, translation: true }
            : { ...input, intent: 'translation' }
      }
      if (editor === 'hwp' && call.name === 'replace_all')
        input = { ...input, undo_unit: 'paragraph' }
      return (workflow ?? skill).executeTool({ ...call, input }, signal)
    },
  }
}
