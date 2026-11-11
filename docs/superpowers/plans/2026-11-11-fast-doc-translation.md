# Fast Document Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Execute the owner's approved speed improvements 1–4 for ordinary-chat in-place Word translation while preserving source formatting and edit safety.

**Architecture:** An editor-memory unit registry supplies locally collected styled segments to a bounded two-request scheduler. A panel-owned translator uses independent pinned transports; one new chat tool starts the run and applies validated results through existing translation tools. Unit IDs never enter saved documents.

**Tech Stack:** TypeScript, Tiptap/ProseMirror, existing Electron AgentTransport, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-fast-doc-translation.md`

## Global Constraints

- Work in the existing isolated `compare-ai` worktree; preserve unrelated changes.
- No live AI requests, credential reads, engine-package changes, new dependency, merge or push.
- At most two independent tool-free requests; pin current provider/model, normal send gates and context.
- Batches target 6,000 serialized source characters and at most 12 units. Above-target paragraphs stay whole; above 24,000 source characters are reported, not truncated.
- Session-memory reuse only; exact source/shape/context verification, no saved IDs.
- All new visible copy uses the 21 locale dictionaries.
- The user approved execution of the four behaviors; integration choices below are implementation rulings within that scope.

## Review Focus

- Duplicate text and legacy fingerprints must not cause a result to land in another paragraph: task 1 duplicate/collision tests.
- Partial selections, redactions and unsupported stories must not expand transmission or claim full completion: tasks 1 and 3 boundary tests.
- Notes can change without a PM transaction: task 1 note-version test and task 3 stale-note application test.
- Reverse completion, stop and retry must not reorder or duplicate document edits: task 2 scheduler tests.
- Provider/model/glossary/style changes must isolate cached results and never activate fallback paid routes: tasks 2 and 3 context/gate tests.

## Task 1: Editor-memory translation units

**Files:** Create `apps/docs/src/renderer/ai/translation-units.ts` and `apps/docs/tests/translation-units.test.ts`. Reuse `translate-runs.ts`; small extraction helper exports are permitted only if existing behavior and tests remain unchanged.

**Interfaces:** Export `TranslationUnit` with `id`, `version`, `segments`, `fp`, `shape`, body/note address, and current range; `TranslationUnitIndex` with `snapshot(range?, includeNotes?)`, `resolve(unit)`, `dispose()`. Export `createTranslationUnitIndex(editor, getNotes?)`. Exact concrete address unions must be shared with task 2 before implementation there.

- [x] Write failing real-editor tests for initial extraction, unchanged extraction reuse, a one-block edit, insert/delete, split/merge, duplicate text/fingerprint collision, unambiguous node move, full replacement, shape/segmentation changes and external note edits.
- [x] Run those tests and observe missing index behavior fail.
- [x] Implement local identities/versions, mapping and immutable-node extraction cache using existing run-group semantics. Resolve addresses immediately before writes. No PM attributes or file writes.
- [x] Run unit-index tests and existing translate-runs/notes/roundtrip/redaction tests.
- [x] Review the exported contract and commit after verification with repository author/trailer conventions.

## Task 2: Batched translation runner and result reuse

**Files:** Create `apps/docs/src/renderer/ai/document-translator.ts` and `apps/docs/tests/document-translator.test.ts`.

**Interfaces:** Consume task 1 unit snapshots/resolve contract through injected adapter dependencies. Export `AiDocumentTranslator`, `DocumentTranslationSpec` and `DocumentTranslationResult`; `run(spec, signal?)` reports completed/reused/failed/stale/skipped/stopped counts. Dependencies supply pinned request execution, current unit resolution and formatted application. Keep scheduler tests independent from panel/UI. Final interface is recorded in the ledger before task 3 starts.

- [x] Write failing tests for length/item limits, long singleton/oversized reporting, max-two active requests, reversed completion with ordered apply, strict JSON ID/segment validation, partial reply failure and per-unit stale exclusion.
- [x] Add failing stop/late-reply, completed-buffer reuse, already-applied skip, edited-only retry, duplicate-text separation and context/provider/model cache-isolation tests.
- [x] Implement bounded planning, two workers, ordered commit, generation/abort guards and bounded session cache. Cache complete validated outputs only and compare exact source arrays as well as keys. Nonmatching or unsupported items are reported rather than auto-fallback.
- [x] Run scheduler tests and inspect deterministic request/extraction counts against a multi-batch fixture.
- [x] Review and commit verified runner.

## Task 3: Normal-chat translation tool and panel transport

**Files:** Modify `apps/docs/src/renderer/ai/tools.ts`, `docs-skill.ts`, `protocol.ts`, `AiPanel.tsx`, necessary `i18n/ai/*.ts`, and their tests. Add a focused panel/skill integration test if existing fixtures cannot express the flow.

**Interfaces:** Add trailing optional `getTranslator` dependency to `createDocsSkill` and tool execution, analogous to existing writer injection. Expose `translate_document` for explicit in-place whole/range translation with target/source language, complete block range, optional notes and detailed translation instructions/context. Panel owns an index and translator for the editor lifetime, independent transports and pinned run settings; the tool delegates actual writes through the existing `translate_blocks` executor.

- [x] Write failing tool/skill/panel tests proving ordinary-chat availability, existing ask-choice rules, no read-runs model roundtrip for the fast path, exact scope refusal for partial paragraphs, and preservation of existing bilingual/review paths.
- [x] Prove selected provider/model and project glossary/style instructions reach both requests; no global settings mutation or fallback. Test stop/unmount, loading/unavailable gates and independent request cancellation with fake bridges.
- [x] Add `translate_document` to tool description/protocol and inject the panel-owned runner. Reject malformed range/mode before any send; preserve ODT/redaction protections and existing formatted apply semantics. Report progress/counts with translated UI strings.
- [x] Run focused skill/tool/panel tests, all 21-locale checks, docs typecheck and changed-file lint/format.
- [x] Independent review of scope, formatting, context isolation and cancellation; fix demonstrated defects before commit.

## Task 4: Final verification and local build

- [x] Run full docs tests after source stabilizes; run affected shared tests only if shared code changed.
- [x] Run typecheck, changed-file lint/format and required text/theme checks. Record precise counts and known failures rather than claiming live performance.
- [x] Build docs then shell; inspect current app state before a safe authorized local restart. Never force development single-instance takeover or discard unsaved work. No actual AI test messages.
- [x] Update security/privacy/module/tracking documentation for the new route, memory cache and verification limits. Record the scope of legacy bilingual/partial-selection paths.
- [x] Complete independent whole-change review; commit locally and leave integration to the owner.

## Execution ledger

- Ruling: retain existing bilingual, review and partial-paragraph selection paths — their special layout/scope contracts do not safely fit the first in-place executor; all four optimizations apply to whole-document/full-block in-place translation.
- Ruling: keep result reuse in editor memory — no privacy-changing disk persistence or saved-document identifiers are required for stop/failure retry.
- Ruling: use the user-approved existing agent workflow and proceed through reversible implementation without another design approval round.
- Preflight review accepted the direction and identified provenance, atomic commit and cancellation reporting contracts. The following contracts resolve those findings before product implementation.

### Shared unit and commit contract

Task 1 exports these types from `translation-units.ts` (readonly fields may be strengthened):

```typescript
type TranslationAddress =
  | { kind: 'body'; index: number; paragraph?: number }
  | { kind: 'note'; note: 'footnote' | 'endnote'; id: string; paragraph?: number }
interface TranslationRange {
  startBlockIndex: number
  endBlockIndex: number
}
interface TranslationUnit {
  id: string
  version: number
  segments: readonly string[]
  fp: string
  shape: string
  address: TranslationAddress
}
interface TranslationUnitIndex {
  snapshot(range?: TranslationRange, includeNotes?: boolean): TranslationUnit[]
  current(id: string): TranslationUnit | undefined
  resolve(expected: TranslationUnit): TranslationUnit | null
  dispose(): void
}
type TranslationCommit =
  { status: 'applied'; receipt: TranslationUnit } | { status: 'stale' | 'failed'; reason?: string }
```

- Range indices are inclusive top-level block indices, never PM positions. Omitted range means the supported whole body. Include notes only for whole-body scope in this first implementation; partial-range notes are refused before sending.
- `shape` is an opaque exact local-only compatibility signature of source segmentation, fixed inline content and relevant structure. The model receives only IDs and allowed source `segments`, never the signature or protected source represented by it.
- `resolve` rechecks ID/version/exact source segments/shape and returns its current address. `current` is for post-write receipts, never authorization to apply an old result.
- Task 3 supplies `commit(unit, translatedSegments): TranslationCommit` as a synchronous operation: resolve, exact validation, existing formatted executor, then capture current post-write receipt. There is no async gap between validation and write. Notes are checked separately immediately before their commit.
- Task 2 stores successful post-apply receipts with the full context key. Only a currently matching receipt may skip already-applied work on resume. User edits and undo invalidate that receipt. Results completed before cancellation but not applied remain eligible only for matching original source units/context. Source fingerprint alone never authorizes reuse.
- Ruling: no shared AgentLoop changes. The panel-owned translator captures `runSnapshotRef` synchronously before its first write, reports progress/partial counts outside the tool's eventual return, and preserves rollback affordance even when AgentLoop's `awaitToolOrAbort` discards the return. Each formatted batch keeps an undo boundary. A cancellation-after-first-apply panel regression must verify counts, rollback availability and absence of late writes.
- The new tool refuses a partial selection based on the captured request scope, even if focus/DOM selection later moves. Full-document calls made from an external-edited stale baseline must reestablish scope or refuse; they cannot reinterpret a stale explicit block range.
- Translation context includes the prepared trusted project context (glossary/style/language prompts), current user instructions and selected skills; untrusted project material retains its existing data delimiters. Freeze this context and include it in the cache key. No implicit full conversation or unrelated document text is needed.

### Verified implementation checkpoints

- Baseline before implementation: 456 docs files, 4,341 tests passed, 1 existing skipped (`/tmp/translation-fast-baseline.log`).
- Task 1 committed as `7754d9786`: 15 index tests; independent review resolved paragraph-local note signatures and table paragraph extraction caching. A real formatted-write regression preserves receipt IDs across `setNodeMarkup` cleanup while recreated nodes/splits/merges/full replacements still retire provenance.
- Task 2 committed as `47b415e32`: 14 runner tests. Default model `''` remains valid. Replaced-run progress is ignored; exact context is stored once rather than repeated per cache record. A 100-paragraph/20k-context rerun uses all receipts without repeat requests.
- Task 3 initial independent review: 47 tests passed including real chat cancellation, captured held/retry scope, typed blocked failures and note rollback. Root note rollback tests passed 3/3 and existing notes/rollback checks passed (33 total).
- First full docs run: 459 files passed, 1 file failed; 4,381 tests passed, 3 failed, 1 existing skipped. Failures are the intentionally changed normal-prompt/tool baselines and translation-profile size budget in `ai-translation-profile.test.ts`; these require an updated compact prompt and explicit baseline update, not relaxed size criteria.
- Final whole-change review additionally found that raw user instruction/skill text in child translation context bypassed `sanitizeAgentPayload`; Task 3 is adding the normal credential-sanitization path and a real fake-transport regression before final verification. No live AI requests were sent.

### Final verification and delivery

- Task 3 committed as `87b78dc1c`. Sanitized accidental credentials in user/skill/instruction fields using the shared sanitizer. Intentional allowed document segments remain exact; a real formatted adapter regression proves literal document keys/passwords are not replaced by sanitizer placeholders. Focused tool/panel tests: 32 passed. Final scoped independent review resolved the last finding with no new blocker.
- Compacted duplicate translation guidance by about 1,300 characters, updated the intentional normal-profile baseline, and added `translate_document` to the required translation tools. Original 40% profile reduction guard remains unchanged and passes; profile/tool tests: 19 passed.
- Final stable full docs suite: 460 files passed, 4,387 tests passed, 1 existing skipped, exit 0 (`/tmp/translation-fast-final-full-tests.log`). Typecheck exit 0; 38 changed TypeScript files lint exit 0 (3 pre-existing App hook warnings); 43 changed files format check exit 0. English-comment, theme-color and brand checks passed.
- Final docs and shell builds exited 0 (`/tmp/translation-fast-final-build-{docs,shell}.log`). The existing app had no enabled Save or active Stop control; it quit cleanly before relaunch on the same normal profile. New PID 2707 published its two open documents and the renderer answered the local read-only selection control request. No private document text was printed by that check, and no AI request was sent.
- Scope remains the approved first in-place whole/full-block executor; existing bilingual/review/partial-paragraph paths remain available. Memory cache does not persist across editor closure. Live provider throughput and translation quality have not been measured; request/concurrency/reuse improvements are verified with fake transports and real editor fixtures only. No merge or push.
