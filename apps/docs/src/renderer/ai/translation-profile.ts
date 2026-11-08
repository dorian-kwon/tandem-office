/**
 * The slimmer tool set of the translation view's output pane. Every model
 * request carries the whole tool list and system prompt, and a translation run
 * makes many requests, so the authoring tools a translation never touches
 * (mind maps, styles, page setup, text boxes, pictures, charts, watermarks,
 * section breaks, image generation) are left out there.
 *
 * It is a deny-list on purpose: a tool added later stays available until
 * someone decides it does not belong in a translation. The prompt sections
 * that go with these tools are marked in protocol.ts (`omitT`). Normal
 * documents never use this file's lists.
 */
import type { AiProfile } from './protocol'

/** Completed document reads describe an older snapshot; retain a preview in follow-ups.
 * Skill instructions, edit arguments and current-run reads are never shortened here. */
export const TRANSLATION_PAST_TOOL_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  read_runs: 4000,
  read_blocks: 4000,
  get_document_context: 4000,
}

/** Tools withheld from the translation profile, with what each one is for. */
export const TRANSLATION_DROPPED_TOOLS: ReadonlySet<string> = new Set([
  'generate_mindmap',
  'define_style',
  'list_styles',
  'set_page_setup',
  'insert_text_box',
  'insert_picture',
  'insert_chart',
  'edit_chart',
  'insert_section_break',
  'set_watermark',
  'generate_image',
  'image_search',
  'insert_image',
  'create_document',
])

/** The tools a profile offers: `normal` returns the list itself, untouched. */
export function toolsForProfile<T extends { name: string }>(
  tools: readonly T[],
  profile: AiProfile,
): readonly T[] {
  if (profile !== 'translation') return tools
  return tools.filter((tool) => !TRANSLATION_DROPPED_TOOLS.has(tool.name))
}

/** Why a call is refused in this profile, or null when it may run. */
export function profileToolRefusal(profile: AiProfile, toolName: string): string | null {
  if (profile !== 'translation' || !TRANSLATION_DROPPED_TOOLS.has(toolName)) return null
  return `The tool ${toolName} is not available in the translation view. Do not retry it; translate with read_runs and translate_blocks (or add_bilingual / revise_blocks), and use the other tools you were given.`
}
