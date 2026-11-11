# Fast existing-document translation

The owner approved the four proposed speed improvements: a dedicated normal-chat translation path, length-based paragraph batches, two simultaneous batch requests, and reuse of completed work. Their edit question adds an in-memory paragraph index: prepare once, update affected paragraphs, and reject obsolete responses after edits.

## Behavior

Normal chat retains its existing language/output-mode questions. For in-place translation of a whole Word document or complete block range, the AI calls `translate_document` once. The app collects source segments locally, translates bounded batches with the currently selected main provider/model, and applies validated results in source order. There are at most two outstanding model requests, each with its own tool-free transport. No model round trips are needed just to read the next source range.

One paragraph's styled segments stay together. Batches target 6,000 serialized source characters and at most 12 paragraphs; a longer paragraph is a singleton, never silently cut. Units above 24,000 source characters are reported as unsupported. These are initial implementation defaults, not measured optimum values.

Use the existing formatted translation executor for application, including tracked changes, fixed inline objects, redacted text, notes, spacing, and freshness checks. Original-preserving bilingual output, review, and partial-paragraph selections retain their existing tools rather than widening scope. Headers/footers are not silently included or claimed complete. The new tool reports processed, reused, failed, stale, and skipped counts.

## Edit and resume rules

Keep transient unit IDs, versions, exact source segment arrays and source shape only in editor memory. Initialize the index on panel/editor attachment and refresh affected blocks on transactions; immutable unchanged nodes reuse extracted segments. Full document replacement resets the index. Notes live outside the PM tree and are checked separately. Duplicate text is never identity. Preserve identity across moves only when immutable node identity unambiguously proves it; ambiguous split/merge/recreated moves retire old IDs.

Before applying, resolve the unit's current address and compare its ID, version, exact segments and shape. Moved unchanged units may apply at their new location; edited, deleted, split or merged units do not receive stale results. Formatting-only changes can reuse results when source segmentation and fixed-object shape remain compatible; incompatible segmentation is invalidated.

Keep a bounded, session-only cache of complete validated batch/unit results. Keys include unit identity/source version, exact segments/shape, language, translation instructions/project glossary/style context, and pinned provider/model. Retry uses completed work without repeat requests or duplicate application; changed units alone need fresh requests. Results completed and buffered before Stop may be reused; incomplete or late post-cancel results are ignored. Stop aborts both requests and blocks further application. No disk cache or saved-document identifiers are added.

## Constraints and verification

Keep provider selection/send gates, paid-route rules and credential boundaries intact. Freeze provider/model and translation context for a run; never fall back. Tests use fake transport and real editor fixtures without live AI calls. No engine-package changes, new dependency, merge or push. New UI text must cover all 21 repository locales.

Prove concurrency <=2, reverse completion ordered application, source edit/split/merge/delete/move/duplicate safety, notes changing without a PM transaction, fixed objects/formatting/undo, source fingerprint collisions, malformed IDs/segment counts, cancellation, resume, cache isolation and ordinary-chat tool wiring. Measure request/extraction counts with deterministic fixtures; do not claim live speedups without measurement.
