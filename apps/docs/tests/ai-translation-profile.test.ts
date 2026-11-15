import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../src/renderer/editor/extensions'
import { createDocsSkill } from '../src/renderer/ai/docs-skill'
import {
  AGENT_SYSTEM_PROMPT,
  buildAgentSystemPrompt,
  type AiProfile,
} from '../src/renderer/ai/protocol'
import { AGENT_TOOLS } from '../src/renderer/ai/tools'
import {
  TRANSLATION_DROPPED_TOOLS,
  profileToolRefusal,
  toolsForProfile,
} from '../src/renderer/ai/translation-profile'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/**
 * Fingerprints of the prompt and tool list as they were before profiles existed. The tool
 * fingerprint was re-pinned when read_runs and translate_blocks gained the text box `box`
 * field, and again when analyze_media's description began naming document_ocr for pictures
 * that are not image blocks (deliberate changes to what every profile sends); nothing else may
 * move it.
 */
const PRE_PROFILE_PROMPT_SHA = '02b4feecd02268794937d822caf71ea189b4cec097f337fd25fdd594e34a943a'
const PRE_PROFILE_PROMPT_LENGTH = 25100
const PRE_PROFILE_TOOLS_SHA = '02fcfc44419ec12983d429f2ed58f2d8704036e480221ff1169ffa6b81f316c7'

/** Tools a translation workflow can need: none of them may ever be dropped. */
const MUST_KEEP = [
  'get_document_context',
  'read_blocks',
  'read_runs',
  'translate_blocks',
  'add_bilingual',
  'revise_blocks',
  'replace_blocks',
  'replace_selection',
  'write_document',
  'apply_ops',
  'read_revisions',
  'accept_changes',
  'reject_changes',
  'read_comments',
  'reply_comment',
  'resolve_comment',
  'add_comment',
  'delete_comment',
  'insert_footnote',
  'insert_endnote',
  'edit_note',
  'read_notes',
  'delete_note',
  'set_header_footer',
  'analyze_media',
  'web_search',
  'read_url',
]

const jsonSize = (tools: readonly unknown[]): number => JSON.stringify(tools).length
/** A docs skill with only the editor and the profile set (the arguments between are optional). */
const docsSkill = (getEditor: () => Editor, profile?: () => AiProfile) =>
  createDocsSkill(
    getEditor,
    () => ({ bullet: null, ordered: null }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    profile,
  )
const liveEditors: Editor[] = []
afterEach(() => {
  for (const editor of liveEditors.splice(0)) editor.destroy()
})
function createEditor(): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
    content: {
      type: 'doc',
      content: [
        {
          type: 'docParagraph',
          attrs: { docxIndex: null },
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
    },
  })
  liveEditors.push(editor)
  return editor
}
const skillFor = (profile: AiProfile | undefined) => {
  const editor = createEditor()
  return docsSkill(() => editor, profile ? () => profile : undefined)
}

describe('normal profile is unchanged', () => {
  it('the system prompt is byte-identical to the one before profiles', () => {
    expect(AGENT_SYSTEM_PROMPT).toBe(buildAgentSystemPrompt('normal'))
    expect(AGENT_SYSTEM_PROMPT).toBe(buildAgentSystemPrompt())
    expect(AGENT_SYSTEM_PROMPT.length).toBe(PRE_PROFILE_PROMPT_LENGTH)
    expect(sha(AGENT_SYSTEM_PROMPT)).toBe(PRE_PROFILE_PROMPT_SHA)
  })

  it('the tool list is the same array, byte-identical', () => {
    expect(toolsForProfile(AGENT_TOOLS, 'normal')).toBe(AGENT_TOOLS)
    expect(sha(JSON.stringify(AGENT_TOOLS))).toBe(PRE_PROFILE_TOOLS_SHA)
  })

  it('a docs skill without a profile, or with the normal one, offers everything', () => {
    for (const skill of [skillFor(undefined), skillFor('normal')]) {
      expect(skill.tools).toHaveLength(AGENT_TOOLS.length)
      expect(skill.systemPrompt.startsWith(AGENT_SYSTEM_PROMPT)).toBe(true)
    }
  })
})

describe('translation profile', () => {
  const kept = toolsForProfile(AGENT_TOOLS, 'translation').map((tool) => tool.name)

  it('drops only tools that exist, and never one a translation can need', () => {
    const all = new Set(AGENT_TOOLS.map((tool) => tool.name))
    for (const name of TRANSLATION_DROPPED_TOOLS) expect(all.has(name)).toBe(true)
    for (const name of MUST_KEEP) {
      expect(all.has(name)).toBe(true)
      expect(kept).toContain(name)
    }
    expect(kept).toHaveLength(AGENT_TOOLS.length - TRANSLATION_DROPPED_TOOLS.size)
  })

  it('does not name a dropped tool in its prompt', () => {
    const prompt = buildAgentSystemPrompt('translation')
    for (const name of TRANSLATION_DROPPED_TOOLS) expect(prompt).not.toContain(name)
  })

  it('keeps the reading, run formatting, notes, comments and safety sections', () => {
    const prompt = buildAgentSystemPrompt('translation')
    for (const part of [
      '# Intent resolution',
      '# Tool usage',
      'read_runs',
      'translate_blocks',
      '# Comments',
      '# Fields, footnotes & endnotes',
      'insert_footnote',
      '# Tracked revisions',
      '# Headers & footers',
      '# HTML fragment rules',
      '# apply_ops guide',
      'setMatchedFont',
    ])
      expect(prompt).toContain(part)
    for (const gone of ['# Mind map', '# Template filling', 'insert_chart', 'setImageProperties'])
      expect(prompt).not.toContain(gone)
  })

  it('a docs skill in the profile offers the smaller set and prompt', () => {
    const skill = skillFor('translation')
    expect(skill.tools.map((tool) => tool.name)).toEqual(kept)
    expect(skill.systemPrompt.startsWith(buildAgentSystemPrompt('translation'))).toBe(true)
  })

  it('the profile is read live, per request', () => {
    let profile: AiProfile = 'normal'
    const editor = createEditor()
    const skill = docsSkill(
      () => editor,
      () => profile,
    )
    expect(skill.tools).toHaveLength(AGENT_TOOLS.length)
    profile = 'translation'
    expect(skill.tools).toHaveLength(kept.length)
  })

  it('refuses a dropped tool the model calls anyway, without touching the document', async () => {
    const editor = createEditor()
    const skill = docsSkill(
      () => editor,
      () => 'translation',
    )
    const before = JSON.stringify(editor.getJSON())
    const result = await skill.executeTool(
      { id: 'c1', name: 'insert_text_box', input: { text: 'x' } },
      undefined,
    )
    expect(result.isError).toBe(true)
    expect(result.mutated).toBe(false)
    expect(result.output).toContain('insert_text_box')
    expect(result.output).toContain('translation view')
    expect(JSON.stringify(editor.getJSON())).toBe(before)
    expect(profileToolRefusal('normal', 'insert_text_box')).toBeNull()
    expect(profileToolRefusal('translation', 'read_runs')).toBeNull()
  })

  it('is at least 40 percent smaller than the normal profile', () => {
    const normal = AGENT_SYSTEM_PROMPT.length + jsonSize(AGENT_TOOLS)
    const slim =
      buildAgentSystemPrompt('translation').length +
      jsonSize(toolsForProfile(AGENT_TOOLS, 'translation'))
    expect(slim).toBeLessThanOrEqual(normal * 0.6)
  })
})

describe('panel wiring', () => {
  const panel = readFileSync(resolve(__dirname, '../src/renderer/ai/AiPanel.tsx'), 'utf8')

  it('asks the pane type at run start, falls back to the normal profile, and hands it to the skill', () => {
    expect(panel).toContain('window.desktop?.isTranslationOutput?.()')
    expect(panel).toContain('.catch(() => false)')
    expect(panel).toContain("aiProfileRef.current = outputPane ? 'translation' : 'normal'")
    expect(panel).toContain('() => aiProfileRef.current')
  })
})
