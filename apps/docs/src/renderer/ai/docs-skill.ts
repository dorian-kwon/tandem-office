import type { AiDocumentTranslationAccess } from './translation-chat'
import { placeholderInstruction } from './redact'
import { redactLabelsOf } from './redact-view'
import type { Editor } from '@tiptap/core'
import { attachedImageNote, type AgentSkill } from '@genoffice/agent-core'
import {
  buildAgentSystemPrompt,
  buildDocContext,
  type AiProfile,
  getSelectionScope,
  type AiTrack,
  type NumIds,
} from './protocol'
import type { AiDocWriter } from './doc-writer'
import type { AiPageSetupAccess } from './page-setup'
import {
  AGENT_TOOLS,
  executeTool,
  markDocSeen,
  type AiCommentsAccess,
  type AiHeaderFooterAccess,
  type FrozenSelection,
  type AiDocExtras,
  type AiAttachmentAccess,
} from './tools'
import type { AiNotesAccess } from './note-ops'
import type { AgentToolDef } from '../../shared/ipc'
import { isOdtSession } from '../odt-gate'
import { ODT_SYSTEM_NOTE, odtToolFilter } from './odt-tools'
import { profileToolRefusal, toolsForProfile } from './translation-profile'

const IMAGE_GEN_OFF_NOTE =
  '\n\nNote: generate_image is currently unavailable (no image provider: no Codex subscription connected and no image API key in Settings). Do not call or promise it; use image_search for imagery.'

const MEDIA_ANALYSIS_OFF_NOTE =
  '\n\nNote: analyze_media is currently unavailable (no media provider: no AI connection that can look at pictures and no media API key in Settings). You cannot see what a picture inside the document shows — tell the user that instead of guessing at its content.'

/**
 * The docx capability as an AgentSkill: document skeleton context, the five
 * document tools, and the local executor. Future apps register their own
 * skills (Excel / PPT) against the same agent loop.
 */
export function createDocsSkill(
  getEditor: () => Editor,
  getNumIds: () => NumIds,
  getTrack?: () => AiTrack | undefined,
  getComments?: () => AiCommentsAccess | undefined,
  getHf?: () => AiHeaderFooterAccess | undefined,
  /** live predicate (the main process's tool capabilities: a subscription or a media key); false hides generate_image */
  imageGenAvailable?: () => boolean,
  /** streaming long-form writer behind write_document (panel-owned: progress chip, partial keep/discard) */
  getWriter?: () => AiDocWriter | undefined,
  getPageSetup?: () => AiPageSetupAccess | undefined,
  /** styles.xml catalog + page watermark stores (define_style / applyStyle / set_watermark) */
  getExtras?: () => AiDocExtras | undefined,
  getNotes?: () => AiNotesAccess | undefined,
  /** same as imageGenAvailable, for analyze_media (seeing pictures that are in the document) */
  mediaAnalysisAvailable?: () => boolean,
  /** the files attached to this chat, so insert_image can take one the user made elsewhere */
  getAttachments?: () => AiAttachmentAccess | undefined,
  /** the tool and prompt set of this run; absent: the whole assistant */
  getProfile?: () => AiProfile,
  getTranslator?: () => AiDocumentTranslationAccess | undefined,
): AgentSkill {
  // Selection frozen per run: tools act on the range the prompt described,
  // not on wherever the user's live selection has wandered mid-run. The doc
  // snapshot bounds the freeze's validity (see FrozenSelection).
  let frozen: FrozenSelection | null = null
  const profile = (): AiProfile => getProfile?.() ?? 'normal'
  /** tools that need a media provider: a connected subscription, or a media key in Settings */
  const mediaToolsOff = (): Set<string> => {
    const hidden = new Set<string>()
    if (imageGenAvailable?.() === false) hidden.add('generate_image')
    if (mediaAnalysisAvailable?.() === false) hidden.add('analyze_media')
    return hidden
  }
  const mediaOffNote = (): string =>
    [...mediaToolsOff()]
      // generate_image is not offered in the translation profile: no note about it there
      .filter((name) => !(name === 'generate_image' && profile() === 'translation'))
      .map((name) => (name === 'generate_image' ? IMAGE_GEN_OFF_NOTE : MEDIA_ANALYSIS_OFF_NOTE))
      .join('')
  return {
    id: 'docx',
    // live: the predicate is re-read before every model request
    get systemPrompt() {
      // only when the open document actually withholds something, so a
      // document without spans pays nothing and the model is not told to
      // look for markers that are not there
      const editor = getEditor()
      const labels = editor
        ? redactLabelsOf(editor.getJSON() as unknown as Parameters<typeof redactLabelsOf>[0])
        : []
      const redact = labels.length > 0 ? `\n\n${placeholderInstruction(labels)}` : ''
      const odt = isOdtSession() ? ODT_SYSTEM_NOTE : ''
      // insert_image is not offered in the translation profile, so its note is left out too
      const attached =
        profile() === 'translation'
          ? ''
          : attachedImageNote(
              getAttachments?.()?.names() ?? [],
              'call insert_image with attachment set to the name',
            )
      const base = buildAgentSystemPrompt(profile())
      return base + mediaOffNote() + attached + redact + odt
    },
    get tools() {
      const hidden = mediaToolsOff()
      const offered = toolsForProfile(AGENT_TOOLS, profile())
      const tools = hidden.size === 0 ? offered : offered.filter((t) => !hidden.has(t.name))
      // an ODT document: tools for switched-off features are not offered
      return odtToolFilter(tools) as AgentToolDef[]
    },
    buildContext: () => {
      const editor = getEditor()
      markDocSeen(editor) // the context the model receives is the freshness baseline for index-addressed writes
      frozen = { scope: getSelectionScope(editor), doc: editor.state.doc }
      return buildDocContext(
        editor,
        frozen.scope,
        getComments?.()?.list(),
        getHf?.()?.read(),
        getPageSetup?.()?.list(),
      )
    },
    executeTool: (call, signal) => {
      // a tool the profile withheld is refused even when the model calls it anyway
      const refusal = profileToolRefusal(profile(), call.name)
      if (refusal) return { output: refusal, isError: true, mutated: false, summary: call.name }
      return executeTool(
        getEditor(),
        call,
        getNumIds(),
        getTrack?.(),
        signal,
        frozen,
        getComments?.(),
        getHf?.(),
        getWriter?.(),
        getPageSetup?.(),
        getExtras?.(),
        getNotes?.(),
        getAttachments?.(),
        getTranslator?.(),
      )
    },
  }
}
