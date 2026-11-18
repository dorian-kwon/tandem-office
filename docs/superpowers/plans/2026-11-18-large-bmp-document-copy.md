# Large BMP Document Copy Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve the already integrated memory/HWP work.

**Goal:** Offer an original-preserving JPEG copy before opening a document dominated by embedded BMP images.

**Architecture:** The shell owns an asynchronous opening preflight and isolated conversion job. HWP and ZIP container adapters replace only image bytes and their format references; a bounded decoder and native JPEG encoder preserve dimensions.

**Tech Stack:** Electron, TypeScript, existing CFB/ZIP helpers, nativeImage JPEG encoding, Vitest, Playwright.

## Task 1: HWP container adapter

Files: `apps/hwp/src/main/embedded-bmp.ts`, `apps/hwp/tests/embedded-bmp.test.ts`.

- [x] Add failing synthetic preservation/compression/identity tests.
- [x] Implement inspect/optimize with injected asynchronous encoder and cancellation.
- [x] Verify all non-image raw streams and unchanged DocInfo fields.
- [x] Pass focused tests/typecheck/lint.

## Task 2: ZIP document adapter

Files: `apps/shell/src/main/document-images/zip.ts`, corresponding shell tests.

- [x] Add fixtures for DOCX/XLSX/PPTX/HWPX relationships/manifests.
- [x] Implement bounded inspection and targeted replacement with stable IDs.
- [x] Preserve unknown payloads; reject ambiguity, signatures and collisions.
- [x] Pass focused tests/typecheck/lint.

## Task 3: Codec and isolated job

Files: `apps/shell/src/main/document-images/bmp.ts`, process/protocol modules and tests,
`apps/shell/electron.vite.config.ts`.

- [x] Test BMP bounds, color orientation, unsupported/transparency cases.
- [x] Implement sequential decoding and native JPEG handoff without large IPC messages.
- [x] Enforce cancellation/resource limits and cleanup.
- [x] Test native encoding and measured temporary-copy conversion of supplied original.

## Task 4: Opening and dialogs

Files: shell opening preflight, localized strings, `apps/shell/src/main/index.ts`, tests.

- [x] Implement threshold and explicit new-copy choice before editor size checks.
- [x] Preserve existing tab focus and handle user-open entry points, including async callers.
- [x] Validate source identity and reject original/existing destination aliases.
- [x] Add progress/result/error behavior and all 21 translations.
- [x] Verify skip/cancel paths and built-app conversion flow.

## Task 5: Integration

- [x] Independent preservation/code review.
- [x] Update decisions, approved release notes and validation records.
- [x] Run affected full tests, typecheck, lint, formatting and guards.
- [x] Build and run E2E; commit with personal identity.
- [ ] Present the release for its final approval.

## Real report verification

- The built app offered a JPEG copy before the original reached the 512 MiB
  HWP read limit. The supplied HWP went from 723,584,512 to 67,344,896 bytes,
  with 38 BMPs converted and none skipped. The copy loaded in the HWP editor.
- The source SHA-256 matched the pre-conversion hash. The engine returned
  identical text, 74 pages, 112 tables, 2,902 cells, matching memo metadata,
  and identical selection geometry at eight sampled cell ranges.
- On this Mac, selecting the file through getting the save result took about
  25 seconds in the measured run. The highest sampled utility working set was
  2.31 GiB. The shell main process peaked at 0.91 GiB in that sampling.
- In testing, macOS reported 33 MiB of free pages even though it could still
  reclaim memory. Ending inspection on this signal skipped the prompt. The
  utility now uses a working-set cap based on installed memory. Linux uses
  available memory for its additional low-memory guard.

## Integration checks

- The production shell build and ten built-app tests passed on macOS. Six
  covered document copies, including the normal open path, original selection,
  cancellation, existing destination protection, app quit, and JPEG output.
- The shell's BMP and Drive regression suites passed 102 tests. The final HWP
  adapter and mark tests passed 44. The full HWP workspace run passed 1,231
  tests with four skips, followed by the focused on-disk byte-count checks.
- The full shell run had the same three Mac failures reproduced on the baseline
  (Control+W and two MCP environment assumptions). All other 4,369 tests passed,
  with two skips.
