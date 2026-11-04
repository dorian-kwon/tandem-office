/**
 * Every AI window shows the same persistent run status line above the composer,
 * driven by the run loop's events. This guard reads the panels' sources.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO = fileURLToPath(new URL('../../..', import.meta.url))
const source = (path: string): string => readFileSync(join(REPO, path), 'utf8')

/** where a panel builds its loop events, and where it renders the line */
const PANELS: Record<string, { loop: string; view: string }> = {
  docs: { loop: 'apps/docs/src/renderer/ai/AiPanel.tsx', view: 'apps/docs/src/renderer/ai/AiPanel.tsx' },
  sheets: { loop: 'apps/sheets/src/renderer/App.tsx', view: 'apps/sheets/src/renderer/ai/AiChatPanel.tsx' },
  slides: { loop: 'apps/slides/src/renderer/ai/AiPanel.tsx', view: 'apps/slides/src/renderer/ai/AiPanel.tsx' },
  pdf: { loop: 'apps/pdf/src/renderer/ai/AiPanel.tsx', view: 'apps/pdf/src/renderer/ai/AiPanel.tsx' },
  markdown: { loop: 'apps/markdown/src/renderer/ai/AiPanel.tsx', view: 'apps/markdown/src/renderer/ai/AiPanel.tsx' },
  html: { loop: 'apps/html/src/renderer/ai/AiPanel.tsx', view: 'apps/html/src/renderer/ai/AiPanel.tsx' },
  mindmap: { loop: 'apps/mindmap/src/renderer/ai/AiPanel.tsx', view: 'apps/mindmap/src/renderer/ai/AiPanel.tsx' },
  hwp: { loop: 'apps/hwp/src/renderer/ai/AiPanel.tsx', view: 'apps/hwp/src/renderer/ai/AiPanel.tsx' },
  epub: { loop: 'apps/epub/src/renderer/ai/AiPanel.tsx', view: 'apps/epub/src/renderer/ai/AiPanel.tsx' },
}

describe.each(Object.entries(PANELS))('%s AI panel run status', (_name, { loop, view }) => {
  it('wraps the loop events so the status follows the real run', () => {
    const src = source(loop)
    expect(src).toMatch(/useAiRunStatus\(/)
    expect(src).toMatch(/[rR]unStatus\.wrap\(/)
  })

  it('renders the status line', () => {
    expect(source(view)).toMatch(/<AiRunStatusLine\b/)
  })
})
