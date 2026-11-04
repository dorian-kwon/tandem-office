# Embedded image OCR implementation plan

> **For agentic workers:** Execute inline using executing-plans, with test-driven-development and one final independent review.

**Goal:** Read images placed in DOCX and XLSX sources through the existing whole-document or selected-item OCR flow.

**Architecture:** A bounded, read-only OPC reader lists referenced raster images in document order, with document-part or sheet/cell locations. OCR leases retain descriptors, not image bytes; selected bytes are re-read from the original archive. Small local previews are loaded lazily over a separate preview channel and prepared through the shell's native image decoder. Existing OCR confirmation, AI route, cancellation and output writer remain shared.

**Tech stack:** TypeScript, Electron nativeImage, existing zip-splice reader, fast-xml-parser, Vitest/React.

**Spec:** User request in this conversation: ask whole/selected before OCR, show a selectable list, implement embedded DOCX/XLSX images.

## Constraints and review focus

- Read source files only; output goes to a new Word document in output/.
- Never send an image before the final start confirmation; previews are local.
- Reject external relationships, changed sources, unsupported formats, oversize archive parts and malformed ZIP data.
- List only images placed in content, excluding orphan media and OLE preview images.
- Preserve document/sheet order and useful locations; shared images are listed once at their first occurrence.
- No real AI calls in automated tests. Existing UI changes in the checkout belong to this work.

## Tasks

1. [x] Add failing tests for bounded extraction, document order, sheet/cell locations, duplicates, orphan/external/OLE images and invalid bytes; implement `embedded-images.ts`.
2. [x] Add failing service tests for editable-source preparation, selected-only serving, local previews and changed-source rejection; connect extraction to OCR leases.
3. [x] Add failing UI tests for the OCR entry point and previews; connect the existing selector and add localized accessible copy in all 21 languages.
4. [x] Run related tests, typecheck, formatting and build. Exercise both supplied samples locally without AI, verify source hashes, and perform one independent review.

## Execution record

- Initial state: existing whole/selected dialog changes are uncommitted; preserve them and work in place so the feature uses the same flow.
- Review: removed the picture counter's 2 KB decoration heuristic from OCR enumeration and made the entry point independent of that count. Before native preview decoding, image headers must describe at most 16 million pixels; unsupported/oversize previews return null while the item remains selectable. Preview responses are capped at 64 KB.
- Limits: archive 128 MiB, parts 10,000, part bytes 20 MiB, total declared expanded bytes 256 MiB; XML part 4 MiB and cumulative XML 16 MiB. Actual decompression is capped at declared size plus one byte and CRC checked.
- Local samples: XLSX 36 images, DOCX 117 images; first-image extraction verified, source SHA-256 hashes unchanged, no AI requests.

- Final validation: 369 tests across 22 translation/opening suites passed; shell typecheck, build, changed-file ESLint, Prettier and `git diff --check` passed. Independent review findings addressed. No actual AI requests were made during implementation.

## Correction: source format and explicit OCR placement

The user clarified that embedded OCR results must keep the original file format and document structure. Recognition does not create an output until the person reviews the text and confirms its placement. Excel offers an existing sheet/start cell or a new sheet; Word offers after each image, document end, or an existing table cell. Existing cell contents require explicit replacement permission. Merged follower cells and image/nested-table replacement are refused.

The app analyses document structure locally and offers a safe recommendation with a reason: a neighbouring empty cell, a new sheet, or text after the existing images. Choosing the recommendation fills the destination controls; a separate Save confirmation is still required. No additional model request is used for recommendations. PDF/HWP table preservation is a design constraint for future work; the user explicitly clarified that this is not a request to implement additional format support now.

Implementation files: `ocr-placement.ts`, `ocr-word-tables.ts`, `ocr-xlsx-structure.ts`, `ocr-recommendation.ts`, `OcrPlacementDialog.tsx`; the existing OCR runner pauses before writing and allows destination correction without repeating OCR. The result contract uses `outputPath` instead of a format-specific path name.

Correction validation: 466 tests across 25 suites passed; shell typecheck/build and changed-file ESLint passed. Placement tests separately passed after formatting cleanup. Local sample copies retained 36 XLSX images and 117 DOCX images, original XLSX worksheet XML, and all 8 Word tables. No new AI calls were made.

## Correction 2: sheets pictures OCR as an overlay plus an in-chat placement (owner verdict)

Owner report after trying the first sheets popup: it appeared on the project detail screen after the shell jumped to Home, another window opened as well, and the popup also asked where to put the text. Verdict: the popup only picks pictures and takes the start confirmation; where the text goes is decided in the chat with a recommended option.

Root cause of the extra window and the navigation: `showOcr` in `apps/shell/src/main/index.ts` (the sheets picture host) called `revealShellWindow()` (creates the shell window if it is gone and raises/focuses it even when the asking editor lives in a detached window), `tabManager.openHomeTab()`, and sent `translate:event:open-ocr`, which Home turned into the translation screen with the hidden `ocr-chat` project open (`TranslationPanel` `ocrRequest`), so the dialog only existed while that screen was mounted.

Design: the popup is an overlay view (`WebContentsView`, `?mode=ocr-popup` of the shell bundle) that main adds to the asking window's own content view (`ocr-popup-view.ts`); no BrowserWindow, no tab switch, no screen. Lifecycle lives in main (`ocr-popup-host.ts`): one overlay per asking window, ended only by the person finishing, cancelling, or the asking window closing (then the overlay is destroyed; its renderer cleanup aborts the run, `ai:stream` aborts when its sender is destroyed, the lease is released). The overlay runs the existing `OcrSelectDialog` in `selectOnly` mode: scope/selection with local previews, the quota confirmation, then it reads and returns plain text plus the local recommendation (`ocr-recommendation.ts`, no extra model call) over `translate:ocr-popup-result`; it never opens `OcrPlacementDialog` or writes. Main hands the checked result only to the asking sheets tab, whose renderer sends it as the next message (bubble: "OCR finished: N pictures read"; model text bounded with a truncation note, `ocr-result-message.ts`). The sheets prompt then has the AI show a preview, ask the placement with `ask_choice` (recommended first, reference-only last, typing row on), ask follow-ups only when needed, `read_cells` before writing, and write with `propose_operations` into the open workbook. `OcrPlacementDialog` stays for the translation-project screen's own embedded OCR flow.

Files: new `ocr-popup-host.ts`, `ocr-popup-view.ts`, `shared/ocr-popup.ts`, `OcrPopupScreen.tsx`, sheets `ocr-result-message.ts`; removed `open-ocr` event, `onOpenOcr`, Home/TranslationPanel `ocrRequest`. Strings: shell `ocrPopupIntro` and sheets `aiOcrResultDisplay`, 21 languages.

Known limit: a tab created while the overlay is open is added above it until the window gets focus (the overlay is re-raised on focus). Tests: shell popup host/view/wiring/screen/dialog selectOnly suites, sheets result-message and skill suites; the built app was not run with a real AI.

## Correction 3: order, enlarging and an empty recognition (owner report on the webtoon workbook)

Owner report: the list should follow the workbook order, a picture must be enlargeable, and recognition returned nothing (the AI showed 0 characters for pictures 1 to 3, with no error).

- Order: the first sheet's `drawing1.xml` stores the 36 anchors already in row order (A7, A82, ..., A2314), so that file reproduces no reorder. `listEmbeddedImages` nevertheless followed the stored order, which Excel does not keep by position for pictures added later; it now sorts each drawing by anchor row then column (stable). The rows are labelled "Picture N", name and sheet · cell.
- Enlarging: new bounded local channel `translate:ocr-preview-large` (`previewLarge`, JPEG from `nativeImage`, longest edge 2600 shrinking until at most 2 MB, header pixel check first, same lease and sender rules as the thumbnail, never an AI input) and `OcrImageLightbox` (Left/Right, Esc closes only the lightbox, fit/actual toggle, drag panning).
- Recognition root cause: the pictures were sent with the page-transcription instruction (`AI_READ_INSTRUCTION`), which says to write `[FIGURE]` for drawings and "do not transcribe text inside it". A webtoon strip is a drawing, so the model answered `[FIGURE]`, the parser accepted it, and the plain text was empty. `parseAiPageResponse` of that answer yields 0 characters (test). Embedded pictures now use `PICTURE_OCR_INSTRUCTION` (same answer tags, text in bubbles and captions counts) in the popup (`createOcrAsk({pictures:true})`) and in the chat OCR path (`ocr-chat.ts`).
- Not the cause (checked): sender permissions (translate channels allow the popup sender, `ai:stream` has no sender allow-list, `abortOnDestroyed` only fires on destroy or main-frame navigation), image attachment (the Claude program path puts the base64 image into the stdin content blocks), bytes (valid JPEG, 7019 bytes in the diagnostic run).
- Failures are visible: `runOcr` reports per picture read or failed (`onSettled`, display-safe messages with no paths), the popup shows a review (no text found, could not be read, not read after Stop) with "Retry these pictures" (only those, after the usual confirmation) and "Continue with what was read" (partial results kept; the chat message lists the pictures without text).
- Diagnostic run (approved, once): smallest picture (picture 29, 1500x261 JPEG, 7019 bytes, blank white), provider auto resolved to the Claude program, tools 0, one image; reply `[EMPTY PAGE]` (43 chars), parsed to 0 characters, no error; no new `claude` or `codex` process remained. It shows the transport delivers the image; it does not exercise a picture with text, which a rebuilt app check must confirm.
