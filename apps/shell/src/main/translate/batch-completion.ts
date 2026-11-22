import type { EditorReply } from '@genoffice/project-store/editor-run'

type EditorResult = Extract<EditorReply, { kind: 'done' }>

const complete = 'PROJECT_TRANSLATION_COMPLETE'
const already = 'PROJECT_ALREADY_TRANSLATED'
const pending = 'PROJECT_TRANSLATION_INCOMPLETE'

export const batchCompletionInstructions = [
  'Before replying, check whether all editable translation units are finished, including nested content.',
  'Report the verified outcome in your chat reply only. Never insert the report into the document.',
  `If finished, put ${complete} alone on the final line, exactly as written, without Markdown or punctuation.`,
  `If inspection with the editor tools shows the entire document already needed no changes, put ${already} alone on the preceding line.`,
  `If anything remains, is uncertain, or needs user input, describe it and put ${pending} alone on the final line.`,
].join('\n')

function lastLine(text: string): string {
  return text.trimEnd().split('\n').at(-1)?.trim() ?? ''
}

export function reportedIncomplete(result: EditorResult): boolean {
  return lastLine(result.text) === pending
}

function confirmed(result: EditorResult): boolean {
  const verifiedUnchanged =
    result.inspected && result.text.split('\n').some((line) => line.trim() === already)
  return lastLine(result.text) === complete && (result.mutated || verifiedUnchanged)
}

export async function runBatchTranslation(
  prompt: string,
  send: (prompt: string) => Promise<EditorResult>,
): Promise<EditorResult> {
  let result = await send(prompt + '\n' + batchCompletionInstructions)
  if (!result.incomplete && !reportedIncomplete(result) && !confirmed(result)) {
    // Ask once in the same editor conversation, retaining evidence from the edit turn.
    const report = await send(
      [
        'Report the status of the translation you just worked on in this document. Do not edit it again.',
        'If no edits were made, inspect the current document with a read-only editor tool before reporting that it was already translated.',
        batchCompletionInstructions,
      ].join('\n'),
    )
    result = {
      ...report,
      mutated: result.mutated || report.mutated,
      inspected: result.inspected || report.inspected,
    }
  }
  if (!result.incomplete && !confirmed(result))
    throw new Error('The editor has not confirmed that the entire document is translated.')
  return result
}
