# Resume AI comparison

Authorized scope: continue the existing compare-ai WIP, isolated from main. Copilot and Grok only; explicit engine switches and selection/document scope; units in document order with enabled engines running concurrently within each unit, answers selectable per unit. No push, packaging, application launch, browser automation or real AI requests.

1. Establish baseline: inspect fbffa86ba diff, docs typecheck and all docs tests. Preserve unrelated baseline failures.
2. Add scheduler tests covering ordering, blocked-engine exclusion, batches, pause/resume, stop, replacement and manual integration races; fix only demonstrated failures.
3. Exercise real editor unit enumeration/mapping and per-unit replacement/undo/stale guards. Complete popup controls, safety notices, styling and current-scope start behavior with fake IPC UI tests.
4. Add every new string to all 21 languages. Update obsolete four-engine tests and consent preferences tests; keep browser and AI boundaries fake.
5. Run docs typecheck and entire docs tests, formatting/lint checks for touched files and repository text/theme checks; inspect diff and commit locally on compare-ai. Record remaining decisions and verification limits.

Provisional choices inherited from HANDOFF: paragraph units, 20-unit batches, pause between requests, blocked engines excluded for the run, optional integration using the app's chosen AI. Applying remains an explicit per-unit action with a distinct undo boundary; unsupported objects and truncated units cannot be replaced.

## Execution record

- Baseline: docs typecheck failed on missing translation keys and obsolete test APIs; docs tests had 3 failing files, 12 failing tests. All failures belonged to the interrupted comparison rewrite.
- Added scheduler, integration, unit, editor and popup regressions. Demonstrated and fixed pause completion, concurrent manual operations, undo grouping, concurrent preference writes, stale selection sending, prompt option drift and page callback isolation.
- Selection scope now splits paragraphs and clips the first/last paragraphs. It sends and changes no target text outside the selection. Partial paragraphs do not borrow an entire source paragraph. Missing/structurally mismatched source text is identified per unit and never guessed.
- Preserved provisional defaults: paragraph units, 20-unit batches, 4-second pacing, pause/resume/stop, both engines on, retranslation on; optional automatic integration off unless explicitly enabled. No bulk apply: each unit is chosen explicitly. Consent is version 2 because scope and disclosure changed.
- Final verification: docs typecheck passed; all 453 docs test files passed (4,312 tests passed, 1 existing skip); touched-file ESLint passed with three existing App hook warnings; Prettier, theme-color, English-comment and whitespace checks passed.
- Independent review found a page callback referencing a Node binding. The regression now serializes callbacks into an isolated VM; it failed with `WALL_TEXT is not defined`, then passed after the expression became page-local. The reviewer reported no remaining Critical/Important findings; stale module documentation was updated.
- Verification limit: no application launch, browser automation, actual AI requests, packaging, push or main merge. Live Copilot/Grok compatibility, popup layout and actual integration quality remain unverified.
- Follow-up default: automatic app AI integration requires an explicit saved or current opt-in. A fresh preference record compares the web answers without calling the app AI; the popup regression also verifies that turning the switch on enables integration.

- Copilot follow-up: the current Lexical field and existing submit selector both worked with two explicitly authorized neutral, unsent input probes. Each probe was removed and normalized input length returned to zero. The initial empty-input report was not reproduced; no hydration or focus root cause is claimed. Input matching now ignores editor caret markers only for comparison, waits for matching text and enabled send, submits once, and reports interaction failures separately from site walls. Stop during detection now prevents the browser child from spawning. Both fixes have RED→GREEN regressions; docs and shell were rebuilt successfully without restarting the running application.

- Updated owner requirement: enabled web engines now run concurrently for the same unit. All answers settle before optional integration once and the next unit. Each engine still handles one unit at a time; pause retains in-flight answers, and stop/close cancels all active controllers. Blocked engines never cancel their peers or retry. The 21 existing consent translations describe destinations and scope without claiming sequential engine scheduling, so their text and consent version remain unchanged.

- Parallel scheduling verification: runner 14 and popup 17 regressions passed; docs typecheck and the full docs suite passed (453 files, 4,312 tests, 1 existing skip). Both docs and shell rebuilt successfully. No live engine messages were sent during verification.
