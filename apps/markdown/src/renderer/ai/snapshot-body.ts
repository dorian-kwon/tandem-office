import type { Node as PmNode } from '@tiptap/pm/model'
import type { SourceMap } from '../markdown/sourceSplice'

/** One pre-edit body for repeated tool reads within a run. A save can replace
 * the verbatim source map even if the immutable ProseMirror document is unchanged. */
export class SnapshotBody {
  private last?: { doc: PmNode; map: SourceMap | null; body: string }

  read(doc: PmNode, map: SourceMap | null, serialize: () => string): string {
    if (this.last?.doc === doc && this.last.map === map) return this.last.body
    const body = serialize()
    this.last = { doc, map, body }
    return body
  }
}
