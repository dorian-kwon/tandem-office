/** Editor history for a text replacement. The studio's transaction still owns atomic
 * failure rollback; the retained undo command stores just the changed paragraphs. */
export const TEXT_COMMAND = 'plugin:ieum-agent:replacement'

function paragraphState(doc, hit, path) {
  const { sec, para } = hit
  const length = path
    ? doc.getCellParagraphLengthByPath(sec, para, path)
    : doc.getParagraphLength(sec, para)
  const text = path
    ? doc.getTextInCellByPath(sec, para, path, 0, length)
    : doc.getTextRange(sec, para, 0, length)
  const shapes = path
    ? doc.getCharShapeRunsInCellByPath(sec, para, path, 0, length)
    : doc.getCharShapeRuns(sec, para, 0, length)
  return { text, shapes, length }
}

// Save only the different text. An edit to a word in a long paragraph does not
// retain the entire paragraph twice for each undo step.
function changedRange(before, after) {
  const a = Array.from(before.text)
  const b = Array.from(after.text)
  let first = 0
  while (first < a.length && first < b.length && a[first] === b[first]) first++
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > first && bEnd > first && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--
    bEnd--
  }
  before.text = a.slice(first, aEnd).join('')
  after.text = b.slice(first, bEnd).join('')
  return first
}

function replaceParagraphState(doc, hit, path, offset, from, to, replaceHit) {
  const current = paragraphState(doc, hit, path)
  const count = Array.from(from.text).length
  if (
    current.shapes !== from.shapes ||
    current.length !== from.length ||
    Array.from(current.text)
      .slice(offset, offset + count)
      .join('') !== from.text
  ) {
    throw new Error('The paragraph changed after the recorded replacement')
  }
  if (count || to.text) replaceHit(doc, { ...hit, charOffset: offset, length: count }, to.text)
  if (to.length) {
    const result = path
      ? doc.setCharShapeRunsInCellByPath(hit.sec, hit.para, path, 0, to.length, to.shapes)
      : doc.setCharShapeRuns(hit.sec, hit.para, 0, to.length, to.shapes)
    if (JSON.parse(result).ok === false) throw new Error('Could not restore character formatting')
  }
}

/** A paragraph with a control can include a field anchor whose metadata changes when
 * its text moves. The engine's paragraph fragment retains that metadata, including tables. */
export function captureReplacement(doc, hit, path, protectedParagraph, replaceHit) {
  const before = protectedParagraph ? null : paragraphState(doc, hit, path)
  if (!before || /[\t\r\n]/.test(before.text)) {
    let fragment = doc.captureDeleteRange(hit.sec, hit.para, hit.para)
    return {
      finish() {},
      apply() {
        const next = doc.captureDeleteRange(hit.sec, hit.para, hit.para)
        try {
          doc.restoreDeleteFragment(fragment)
        } catch (error) {
          doc.discardDeleteFragment(next)
          throw error
        }
        fragment = next
      },
      discard() {
        doc.discardDeleteFragment(fragment)
      },
    }
  }
  let after
  let offset
  return {
    finish() {
      after = paragraphState(doc, hit, path)
      offset = changedRange(before, after)
    },
    apply(undo) {
      replaceParagraphState(
        doc,
        hit,
        path,
        offset,
        undo ? after : before,
        undo ? before : after,
        replaceHit,
      )
    },
  }
}

function replacementCommand(parts, cursorBefore, cursorAfter) {
  function restore(wasm, undo) {
    // The temporary snapshot guards failures midway through a multi-paragraph replacement.
    const original = wasm.saveSnapshot()
    try {
      wasm.beginDeferredPagination()
      for (let i = 0; i < parts.length; i++) parts[undo ? parts.length - 1 - i : i].apply(undo)
      wasm.flushDeferredPagination()
    } catch (error) {
      try {
        wasm.cancelDeferredPagination()
      } finally {
        wasm.restoreSnapshot(original)
      }
      throw error
    } finally {
      wasm.discardSnapshot(original)
    }
    return { ...(undo ? cursorBefore : cursorAfter) }
  }
  return {
    type: TEXT_COMMAND,
    timestamp: Date.now(),
    mergeWith: () => null,
    execute: (wasm) => restore(wasm, false),
    undo: (wasm) => restore(wasm, true),
    discard: () => {
      for (const part of parts) part.discard?.()
    },
  }
}

/** Intercept just the plugin's current synchronous transaction. On success its snapshot
 * is released before native history accounting, so it cannot evict a preceding manual edit. */
export function withReplacementHistory(history, parts, split, remember, run) {
  const previous = history.execute
  let recorded = false
  history.execute = function (command, wasm) {
    if (!command.type?.startsWith('snapshot:plugin:ieum-agent:'))
      return previous.call(this, command, wasm)
    const noOp = command.isNoOp
    command.isNoOp = function () {
      return parts.length > 0 || noOp?.call(this)
    }
    try {
      const position = previous.call(this, command, wasm)
      if (parts.length) {
        for (const unit of split ? parts.map((p) => [p]) : [parts]) {
          const entry = replacementCommand(unit, command.cursorBefore, position)
          history.recordWithoutExecute(entry, wasm)
          remember(entry)
        }
        recorded = true
      }
      return position
    } finally {
      command.isNoOp = noOp
    }
  }
  try {
    return run()
  } finally {
    history.execute = previous
    if (!recorded) for (const part of parts) part.discard?.()
  }
}
