# Resume AI comparison

Authorized scope: continue the existing compare-ai WIP, isolated from main. Copilot and Grok only; explicit engine switches and selection/document scope; sequential requests, answers selectable per unit. No push, packaging, application launch, browser automation or real AI requests.

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
- Preserved provisional defaults: paragraph units, 20-unit batches, 4-second pacing, pause/resume/stop, both engines on, retranslation on, optional automatic integration on. No bulk apply: each unit is chosen explicitly. Consent is version 2 because scope and disclosure changed.
- Final verification: docs typecheck passed; all 452 docs test files passed (4,298 tests passed, 1 existing skip); touched-file ESLint passed with three existing App hook warnings; Prettier, theme-color, English-comment and whitespace checks passed.
- Independent review found a page callback referencing a Node binding. The regression now serializes callbacks into an isolated VM; it failed with `WALL_TEXT is not defined`, then passed after the expression became page-local. The reviewer reported no remaining Critical/Important findings; stale module documentation was updated.
- Verification limit: no application launch, browser automation, actual AI requests, packaging, push or main merge. Live Copilot/Grok compatibility, popup layout and actual integration quality remain unverified.
