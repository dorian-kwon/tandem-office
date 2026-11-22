/**
 * Every AI panel that shares the status line also registers the `ask_choice` tool, draws its
 * card above the status line and shows the readable form of a tagged answer. These guards
 * read the panels' sources and keep the wiring the same everywhere.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const source = (path: string): string => readFileSync(join(REPO, path), 'utf8')

/** where a panel builds its hook and tools, and where it renders the chat */
const PANELS: Record<string, { loop: string; view: string }> = {
  docs: {
    loop: 'apps/docs/src/renderer/ai/AiPanel.tsx',
    view: 'apps/docs/src/renderer/ai/AiPanel.tsx',
  },
  sheets: {
    loop: 'apps/sheets/src/renderer/App.tsx',
    view: 'apps/sheets/src/renderer/ai/AiChatPanel.tsx',
  },
  slides: {
    loop: 'apps/slides/src/renderer/ai/AiPanel.tsx',
    view: 'apps/slides/src/renderer/ai/AiPanel.tsx',
  },
  pdf: {
    loop: 'apps/pdf/src/renderer/ai/AiPanel.tsx',
    view: 'apps/pdf/src/renderer/ai/AiPanel.tsx',
  },
  markdown: {
    loop: 'apps/markdown/src/renderer/ai/AiPanel.tsx',
    view: 'apps/markdown/src/renderer/ai/AiPanel.tsx',
  },
  html: {
    loop: 'apps/html/src/renderer/ai/AiPanel.tsx',
    view: 'apps/html/src/renderer/ai/AiPanel.tsx',
  },
  mindmap: {
    loop: 'apps/mindmap/src/renderer/ai/AiPanel.tsx',
    view: 'apps/mindmap/src/renderer/ai/AiPanel.tsx',
  },
  hwp: {
    loop: 'apps/hwp/src/renderer/ai/AiPanel.tsx',
    view: 'apps/hwp/src/renderer/ai/AiPanel.tsx',
  },
  epub: {
    loop: 'apps/epub/src/renderer/ai/AiPanel.tsx',
    view: 'apps/epub/src/renderer/ai/AiPanel.tsx',
  },
}

describe.each(Object.entries(PANELS))('%s AI panel ask_choice', (_name, { loop, view }) => {
  it('uses the shared hook and registers its skill with the run loop', () => {
    const src = source(loop)
    expect(src).toMatch(/useAiChoice\(/)
    expect(src).toContain('projectTurn.current?.batchChoices')
    expect(src).toMatch(/\bchoice\.skill\b/)
  })

  it('renders the card and shows tagged answers as readable bubbles', () => {
    const card = source(loop)
    const shown = source(view)
    // the card is drawn by the file that owns the chat view (sheets hands it down as a prop)
    expect(view === loop ? shown : card).toMatch(/choice\.card|aiChoiceCard/)
    expect(shown).toMatch(/\{choice\.card\}|\{choiceCard\}/)
    expect(shown).toMatch(/choiceBubbleText\(/)
  })
})
