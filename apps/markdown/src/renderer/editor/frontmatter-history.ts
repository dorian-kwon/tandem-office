import type { Editor } from '@tiptap/core'
import type { Node as PmNode, Schema } from '@tiptap/pm/model'
import type { Transaction } from '@tiptap/pm/state'
import { Step, StepResult } from '@tiptap/pm/transform'

/** The complete YAML block, including fences and the original following blank lines. */
export interface FrontmatterAccess {
  read(): string
  write(raw: string): void
}

// Frontmatter lives outside the body tree. A position-free step can travel with
// the body steps in native history without making YAML a rendered paragraph.
class FrontmatterStep extends Step {
  constructor(
    readonly before: string,
    readonly after: string,
  ) {
    super()
  }

  apply(doc: PmNode): StepResult {
    return StepResult.ok(doc)
  }
  invert(): FrontmatterStep {
    return new FrontmatterStep(this.after, this.before)
  }
  map(): FrontmatterStep {
    return this
  }
  toJSON() {
    return { stepType: 'markdownFrontmatter', before: this.before, after: this.after }
  }
  static fromJSON(_schema: Schema, json: { before: string; after: string }): FrontmatterStep {
    return new FrontmatterStep(json.before, json.after)
  }
}
Step.jsonID('markdownFrontmatter', FrontmatterStep)

const stores = new WeakMap<Editor, FrontmatterAccess>()

export function setFrontmatter(
  editor: Editor,
  tr: Transaction,
  store: FrontmatterAccess,
  raw: string,
): void {
  if (!stores.has(editor)) {
    // Step.apply also runs during can().undo() and other speculative transforms.
    // Only touch the envelope after the editor actually dispatched the steps.
    editor.on('transaction', ({ transaction }) => {
      const current = stores.get(editor)!
      for (const step of transaction.steps) {
        if (step instanceof FrontmatterStep && current.read() === step.before)
          current.write(step.after)
      }
    })
  }
  stores.set(editor, store)
  const before = store.read()
  if (before !== raw) tr.step(new FrontmatterStep(before, raw))
}
