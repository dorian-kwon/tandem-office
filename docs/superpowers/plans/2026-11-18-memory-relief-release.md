# Memory relief and 0.15.5

The user resumed Claude session `6b3d9861-7300-4cd0-b289-bc340a2f700a`.
The approved scope is the channel leak fix, an AI undo-history setting (off by
default), collapsing old chat messages, a watchdog reopen dialog that waits for
AI work, a version bump, and the HWPX CPU issue explicitly added by the user. Keep the stopped worktrees and their existing edits.

## Implementation

- [x] Preserve and review channel leak fix `6d6e0421f`; five focused tests pass.
- [x] Finish default-off AI undo history across editor adapters, settings and home gear.
- [x] Collapse earlier chat entries across all nine editor panels without deleting history.
- [x] Make watchdog memory checks relative to available physical memory.
- [x] Reopen through save/close handling, waiting for the full AI edit lifecycle.
- [x] Include privacy-filtered watchdog diagnostics in problem reports.
- [x] Review each feature for scope and correctness, integrate, resolve overlaps.

- [x] Fix redundant HWP cell-highlight geometry work and verify real-engine/built-app behavior.

## Verification

- [x] Focused behavior tests and all changed workspace tests.
- [x] Whole-repository typecheck, lint, formatting and required `check:*` scripts.
- [x] License check and complete build.
- [x] Built-app settings default, toggle and restart persistence test.
- [x] Built-app chat/history and report checks as applicable.
- [x] Record baseline failures separately from regressions.

## Release preparation

- [x] Prepare shell and lockfile version 0.15.5.
- [x] Draft `docs/releases/0.15.5.md`; final wording depends on verified editor behavior.
- [x] Record actual validation and limitations in tracking documents.
- [x] Commit the reviewed result with personal author identity.
- [ ] Present the final release text and any required publication confirmation.

The previous release was Windows-only. Do not claim Windows runtime or installer
validation from macOS tests. GitHub commands must exclude inherited `GH_TOKEN`
and `GITHUB_TOKEN`, which otherwise select the work account; verify the personal
`dorian-kwon` account before accessing this private repository.

## Verification notes

- Integrated branches: channel leak `6d6e0421f`, memory relief `d5359ed3f`,
  undo-history setting `456fb922a`, HWP geometry `c09f61fba`.
- Full typecheck, ESLint (0 errors; 22 existing warnings), formatting, all five
  `check:*` scripts, licenses, and `build:all` passed. Later Docs translation-cache
  corrections receive another focused typecheck/lint and Docs/shell build.
- Built-app tests passed: default/off preference and restart persistence, HWP
  manual/AI undo separation, HWP geometry reuse/zoom, sanitized problem report.
- HWP geometry matches on the supplied original HWP. Decision 0117 records the
  row-aware measurements and distinguishes the selection sample from app latency.
- Full tests caught a Docs translation cache regression and a Mindmap manual
  image-edit undo regression. The final Docs suite passed 4,345 tests (one skip),
  and the final Mindmap suite passed 641 tests.
- Known baseline failures on this Mac: shell Control+W test and two MCP environment/
  temporary-path assumptions; ai-provider two `/var` versus `/private/var` assumptions.
  The shell third-party-notices baseline timeout passed independently (12 tests).
- The full shell suite ran 4,369 passing tests and two skips. The three failures
  reproduced on the baseline. The ZIP, Drive and BMP shell tests were rerun
  after integrating the file-open prompt.
- The BMP work and large-report validation are recorded in the document-copy
  plan. No live AI subscription calls were made during this continuation.
