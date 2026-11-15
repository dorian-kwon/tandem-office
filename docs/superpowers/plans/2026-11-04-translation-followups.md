# Translation Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the translation tool keep a document's formatting, remember recent translation documents, and feed the AI reference material and fixed context cheaply.

**Architecture:** Four independent tasks on top of the finished translation tool (branch `feat/translation-tool`). Formatting is fixed inside the docx editor's AI layer (`apps/docs/src/renderer/ai`) with a run-preserving tool; recents live in the shell's app settings; references become markdown copies with a keyword index queried per request; fixed context is sent once per AI conversation and again only when its hash changes.

**Tech Stack:** TypeScript, Electron, ProseMirror/TipTap (docs editor), vitest, Playwright e2e. Earlier spec: `docs/superpowers/specs/2026-11-02-translation-tool-design.md`; earlier plan: `docs/superpowers/plans/2026-11-02-translation-tool.md`.

## Global Constraints

- Never modify document-engine packages (`packages/docx-engine`, `pptx-engine`, `odt-engine`, `epub-engine`, `pdf-structure`, ...); change only apps and the translate packages.
- No local OCR and no local ML model: AI only. Text extraction from documents uses the existing engines. Keyword search only (no embeddings).
- Subscription programs run with tools off; never switch to a billing path the user did not choose; never touch login files.
- Comments in English only (no Han characters). Product name only from `packages/i18n/src/product.ts`. UI strings in all 21 languages (`apps/shell/src/renderer/src/i18n/translate/*.ts`, `zh.ts` is the type source).
- Internal names `@genoffice/*`, `GENOFFICE_*`, `ieumoffice` command and `.ieumoffice/` folders stay.
- Original files in `source/` and `references/` are never modified; only copies and derived files are written.
- Test-first; commit per task with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Known baseline failures on this Mac: shell `tests/mcp-client/local.test.ts` x2, `tests/tab-shortcuts.test.ts` x1.

## Review Focus

- A paragraph whose runs have different formats (quotes, Hanja, footnote reference between runs) keeps one run per format and keeps the footnote reference node in place.
- Empty paragraphs are never dropped, never given a new style, and never get text.
- Translation longer or shorter than the source, or an AI reply that merges or loses segment markers, never loses text and never throws away formatting.
- A recent entry whose project or file was moved or deleted shows as unavailable instead of crashing or opening the wrong file.
- A reference file that fails to convert (scan without OCR, password, corrupt) leaves the project usable and says so.
- Fixed context changed after the conversation began (prompt or glossary edited) reaches the AI on the next request.

## Task 1: Recent translation documents

**Files:**

- Create: `apps/shell/src/main/translate/recent-documents.ts`, `apps/shell/tests/translate-recent-documents.test.ts`
- Modify: `apps/shell/src/main/translate/translate-ipc.ts`, `apps/shell/src/main/translate/open-translation.ts`, `apps/shell/src/shared/translate-api.ts`, the translate preload bridge, `apps/shell/src/renderer/src/translate/ProjectList.tsx`, `translate.css`, i18n `translate/*.ts` (21 files), `e2e/translate-projects.spec.ts`

**Interfaces:**

- Produces `TranslateRecentDocument { dir: string; projectName: string; file: string; sourceLang: string; targetLang: string; openedAt: number; available: boolean }`; `translateApi.recent(): Promise<TranslateRecentDocument[]>` (newest first, at most 10, one entry per project+file).
- Main records an entry in the app settings file (not in `project.json`) each time `openTranslation` opens a document successfully.

- [ ] **Step 1:** Write tests: recording keeps newest first, de-duplicates by project+file, caps at 10, drops entries of projects removed from the registered list, and marks `available:false` when the project folder or the output file is gone.
- [ ] **Step 2:** Implement `recordRecentDocument` / `listRecentDocuments` in `recent-documents.ts` over the existing app-settings store; wire `translate:recent` through `guard()` and the preload.
- [ ] **Step 3:** Render a "Recent" list above the project list in `ProjectList.tsx` (document name, project name, language pair, relative time); clicking opens the split view via the existing open path; unavailable entries are disabled with a note. Add strings in 21 languages.
- [ ] **Step 4:** Extend the translate e2e: after opening the translation view and returning to the list, the recent list shows the document and clicking it reopens the split view.
- [ ] **Step 5:** Run `npx vitest run tests/translate*` and tsc in `apps/shell`, the english-comments check; commit.

## Task 2: Run-preserving translation tool for the docx editor

**Files:**

- Create: `apps/docs/src/renderer/ai/translate-runs.ts`, `apps/docs/tests/translate-runs.test.ts`
- Modify: `apps/docs/src/renderer/ai/tools.ts` (tool definition and dispatch), the docs AI system prompt text that lists tools, `apps/shell/src/main/translate/context-injection.ts` or `packages/translate-project/src/compose.ts` (translation rule text), `docs/superpowers/notes/manual-checks.md`
- Test fixture: copy of a document from a local test project (`<test project>/source/<document>.docx`) into `apps/docs/tests/fixtures/` only if the repo's fixture policy allows it; otherwise build an equivalent fixture in the test.

**Interfaces:**

- Produces tool `translate_blocks` with input `{ blocks: Array<{ index: number; segments: string[] }> }` where `segments[i]` is the translation of the i-th text-run group of paragraph `index`. Companion `read_runs(startBlockIndex, endBlockIndex)` returns, per paragraph, the ordered run groups as numbered segments (text only) so the model never sees or invents formatting. Paragraph, heading and list-item blocks are supported; tables are supported cell paragraph by cell paragraph; empty paragraphs are listed as `empty:true` and ignored.
- `applyRunTranslation(editor, blockIndex, segments)` replaces text inside existing text nodes via a ProseMirror transaction, keeping each node's marks (`docTextStyle` including raw run bytes), keeping atom nodes (footnote references, tabs, breaks) and paragraph attrs untouched. Segment count mismatch: extra segments are appended to the last group, missing ones leave that group's original text unchanged and the call reports which block was incomplete.

- [ ] **Step 1:** Write failing tests on a constructed document: (a) three runs with different `docTextStyle` plus a footnote reference between them: after translation the run count, marks and footnote node are identical and only text changed; (b) empty paragraph untouched; (c) fewer segments than groups: reported, no text lost; (d) more segments: appended to the last group; (e) tracked-change (`del`) text is skipped.
- [ ] **Step 2:** Implement `readRunGroups` and `applyRunTranslation` in `translate-runs.ts`. A group is a maximal sequence of adjacent text nodes with equal `docTextStyle`; atom nodes split groups.
- [ ] **Step 3:** Register `read_runs` and `translate_blocks` in `tools.ts` with descriptions stating they are the way to translate and that `replace_blocks` must not be used for translation; dispatch them like neighbouring tools, honouring the edit queue / rollback snapshot used by `replace_blocks`.
- [ ] **Step 4:** In the translation context text (`<translation-context>` rules) tell the AI: translate documents with `read_runs` then `translate_blocks`, never delete or restyle empty paragraphs, never touch footnote references, translate footnote text with the note tools.
- [ ] **Step 5:** Verification script/test: take the user's sample docx, translate every non-empty paragraph with a deterministic fake translator through the real editor load/save path, then compare `word/document.xml` with the source: paragraph count and `pStyle` per paragraph equal, run property sets equal per paragraph, footnote reference count equal, empty paragraphs equal. Record the result in the task report.
- [ ] **Step 6:** Run `npx vitest run` in `apps/docs`, tsc, repo checks; commit.

## Task 3: Reference material as markdown with a keyword index

**Files:**

- Create: `packages/translate-project/src/reference-md.ts`, `reference-index.ts`, tests in `packages/translate-project/tests/`
- Modify: `packages/translate-project/src/materials.ts`, `compose.ts`, `apps/shell/src/main/translate/translate-ipc.ts`, `context-injection.ts`, `ProjectDetail.tsx` (status and "view converted text"), i18n files, `PRIVACY.md`, decision doc 0102

**Interfaces:**

- `convertReferenceToMarkdown(file): Promise<{ ok: true; md: string } | { ok: false; reason: 'needs-ocr' | 'unsupported' | 'failed' }>` using existing parsers (`file-parse`, document engines); text-bearing PDFs, docx/hwp/pptx/xlsx/epub/html/md/txt only; scans return `needs-ocr` and use the existing OCR confirmation flow.
- Converted copy: `references/.md/<name>.md`; index file `.tandem/references-index.json` (chunks of heading/paragraph groups with source name, offset, term frequencies, source sha256).
- `queryReferences(dir, text, maxChars): Array<{ file: string; heading: string; text: string }>` BM25 over chunks; total at or below `maxChars` returns everything unindexed.
- Injection: `<translation-references>` fence, each chunk labelled with file and heading, default cap 6000 characters, re-queried per request with the text being translated.

- [ ] **Step 1:** Write failing tests for chunking, BM25 ordering, rebuild when sha changes, cap on characters, small-corpus passthrough, `needs-ocr` for an image-only PDF.
- [ ] **Step 2:** Implement conversion + index; call on add/remove material under the per-dir lock; failures recorded per file, never block the project.
- [ ] **Step 3:** Wire into `composeContext` and the per-request path used by the glossary query.
- [ ] **Step 4:** Detail screen shows per-reference status (converted / needs OCR / failed) and a button to open the converted markdown read-only; 21-language strings; PRIVACY and decision doc state that chosen chunks go to the AI provider.
- [ ] **Step 5:** Run package and shell tests, checks; commit.

## Task 4: Send fixed context once per conversation

**Files:**

- Modify: `apps/shell/src/main/translate/context-injection.ts`, `apps/shell/src/main/projects/*` (project-folder context path), `packages/ui/src/use-project-chat.ts` / `project-skill.ts` as needed, tests alongside
- First read decision 0088 and how each provider (Claude, ChatGPT) keeps a conversation, and record in the task report whether a resumed session really keeps earlier turns.

**Interfaces:**

- Fixed part = system prompt + project prompt + language pair + translation rules; variable part = glossary matches + reference chunks. Fixed part carries a hash; it is sent on the first request of a conversation and again whenever the hash changes or a new conversation / provider session starts; later requests send only the variable part plus a one-line marker `fixed-context: <hash8>`.

- [ ] **Step 1:** Write failing tests: first request includes the fixed part; second request in the same conversation omits it; editing the project prompt re-sends it; a new conversation re-sends it; a provider that does not keep a session (verified in the investigation) always re-sends it.
- [ ] **Step 2:** Implement the hash/conversation bookkeeping in the shell main process, keyed by conversation id, never persisted to disk.
- [ ] **Step 3:** Run tests, checks; commit.

## Final

- [ ] Rebuild, run the translate e2e and home e2e, run the whole shell and docs suites, compare against baseline failures, update `docs/superpowers/notes/manual-checks.md`, `docs/tracking/status.md`; whole-branch review; do not push without the user's word.
