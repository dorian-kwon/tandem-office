# Manual checks for the translation tool

## Known limitations

Collected from the task reports (tasks 9 to 11). They are deliberate or accepted for now; none is a regression.

- Source pane edits are possible in memory but cannot be saved. The file in `source/` is never written by the translation view.
- Residual PDF-editor save-dialog flows (reduce file size, sign, redaction copy) can target `source/` with an operating-system overwrite confirmation. The app does not block them.
- There is no operating-system read-only flag on `source/`; the guard is in the app only.
- The read-only tab is hidden from the MCP tools, so an outside program does not see the source copy as an open document.
- Text-PDF translation uses the app-wide "AI to use" from Settings, while OCR uses the project's choice. Paid logins that the project names are labelled paid before anything is sent.
- A glossary over 200 entries sends only the entries whose terms match the paragraph (or the text); it does not send the whole list.
- "Translate again" keeps blocks a person edited in the PDF editor's bilingual view; there is no choice to discard them.
- The source pane blocks every typing key, so its find box opens but takes no search word, and its AI panel input cannot be typed into. Use the output pane's find and AI panel.
- Unsupported inputs: GIF, BMP, TIFF and WebP images and OpenDocument sheets and slides (`.ods`, `.odp`) are refused when added; password-protected PDFs and images over 20 MB fail when opened. Arabic, Hebrew and Hindi cannot be the target language of a translated PDF.
- Reloading the window while an OCR run is going does not release it; it stays held until it finishes or sits idle for 30 minutes. Closing the window frees it at once.
- No end-to-end spec was run: the app was never launched in this environment (no `cargo`, so the Rust sheets engine does not build). Every item below is unverified in a running app.

The renderer could not be built and launched on the Mac used for development (no
`cargo`, so the Rust sheets engine does not build), so no e2e spec was written
for these screens. Run these by hand in a full build.

## Project list and detail (Task 8)

1. Open the "Translation" item in the Home sidebar. The project list and the global system prompt field show.
2. Create a project: name, source and target language, "Choose folder" opens the native folder dialog. The project folder appears there and the detail screen opens.
3. Upload each of the three kinds in its own list: a document to translate (docx or pdf), a reference file, a glossary (csv). Each appears only in its own list. Multi-select adds every picked file.
4. Delete one item from each list with its own delete button. The file leaves the list and the project folder.
5. Edit the project prompt, click elsewhere, go back to the list and reopen the project: the prompt persists.
6. Change the OCR select (Claude, ChatGPT, Off), reopen the project: the choice persists.
7. Change the language pair, reopen: it persists.
8. "Start translation" is disabled with no source and enabled after a source is added (it has no destination until Task 9).
9. Type a global system prompt, click elsewhere, quit and restart the app: it persists.
10. Delete a project "from list only": the entry leaves the list and the folder stays on disk.
11. Delete a project "list and folder": a second confirmation appears; after confirming, the folder is gone.
12. Rename or delete a project folder in Finder or Explorer, reload the list: the row shows "Folder not found", is not clickable and has "Remove from list".
13. Damage `.tandem/project.json`: the row shows as damaged with "Remove from list".
14. Create a project with a name that already exists in that location: a localized message shows, never raw "Error invoking remote method" text.

## Translation view (Task 9)

Use a project with a docx source and one with a md source.

1. On the detail screen, press "Open translation" on a source. The window splits side by side: the copy from `source/` on the left, `output/<same name>` on the right with focus. Neither file appears in Recent.
2. Source pane rejects edits: click into the left pane and type (Latin and Korean IME), press Backspace, Delete, Enter, Ctrl/Cmd+V, Ctrl/Cmd+X, Ctrl/Cmd+Z. Nothing changes. Arrow keys, Page Up/Down, selecting, Ctrl/Cmd+C, Ctrl/Cmd+F and zoom still work.
3. Source pane rejects save: with the left pane focused, press Ctrl/Cmd+S and use File > Save and File > Save As from the app menu, and Save / Save As from the left tab's right-click menu (greyed out). The file in `source/` keeps its bytes (compare its SHA-256 with `.tandem/project.json`). Repeat for md (markdown editor) and hwp if available.
4. Autosave: turn the app's autosave default on, wait a minute with the left pane open. `source/` is not written.
5. The left tab has no "Open in New Window" and cannot be torn off; dragging it out of the strip leaves it in place.
6. Hide/show keeps scroll: scroll the left pane to the middle, press "Hide source" in the tab strip. The right pane fills the window and the divider disappears. Press "Show source": the left pane is back at the same scroll position, not reloaded. Do the same with "Hide translation". Hiding one pane while the other is hidden shows the other (never both hidden). Clicking the hidden pane's tab in the strip shows it again.
7. Edit the right pane, save, close both tabs, press "Open translation" again: the output copy opens with your edits (it is reused, never overwritten). The output file keeps the original extension.
8. Hash change warning: change the file in `source/` by hand (any byte), press "Open translation": the view opens with the changed copy and, back on Home, the detail screen shows "The source copy has changed since it was added". Delete the file in `source/` and open again: a localized "source copy is missing" message shows and nothing opens.
9. A pdf or image source: "Open translation" shows the localized "cannot open in the translation view yet" message (Task 11 opens these).
10. Close the left pane after typing attempts: no save prompt appears. Quit the app with the translation view open: no prompt for the left pane.
11. Quit and relaunch with no file argument: the translation split comes back with the source pane still read-only and the hidden pane still hidden.
12. The original file you added (outside the project) is never opened or changed in any of the steps above.
13. Known limits of the source pane's key guard, check they are acceptable: typing is blocked, so a find field opened by the editor inside the source pane (Ctrl/Cmd+F) cannot take a search word, and the source pane's own AI panel input cannot take text either; use Find and the AI panel in the right pane or copy text out. On Windows, Alt+letter menu access (e.g. Alt+F) is blocked while the source pane has focus; click the right pane first.
14. Sheets source: open an xlsx source, change cells by mouse (drag-fill, context-menu paste) and use File > Save, the ribbon Save button, and wait with autosave on. Each save is refused with the read-only message and `source/<file>.xlsx` keeps its hash. Same for pptx with File > Save As.
15. "Source copy changed" in the tab strip: after step 8, the strip shows "Source copy changed" next to the hide/show buttons (hover shows the full sentence); its close button removes it.
16. Restore: remove `output/<file>` after quitting with the translation view open, relaunch: the source copy opens alone and is still read-only (typing refused, Save refused), and it is not in Recent.

## Translation context in the AI panels (Task 10a)

Use a translation project with a global system prompt (Home > Translation), a project prompt, a glossary of a few rows and one reference file, plus an ordinary project folder (decision 0088) with an `instructions.md`.

1. Create a new translation project: no trust dialog appears, and the folder now also shows in the AI panel's project list (and on Home > Projects) under the project's folder name.
2. Open the translation view on a docx and an md source. In both panes' AI panels the project chip already shows the translation project; nothing was picked by hand.
3. Send a request from the right pane (e.g. "Translate the first paragraph"). Under the input a line reads "Translation context sent: system prompt · project prompt · glossary (N) · references (1)" (Korean UI: "번역 맥락을 함께 보냈습니다: …"). Send one from the left (read-only) pane too: the same line shows there.
4. The answer follows the prompts and uses the glossary's target terms. If a request log or debug view is available, the system text holds a `<translation-context>` block (global prompt, project prompt, `번역: <src> → <tgt>`) and a separate `<translation-glossary>` block (`단어집:`, `참고자료:`); the user message does not.
5. Glossary over 200 rows: select a sentence containing a term from row 250 and ask to translate it: the line reads "glossary (K matching of N)" and the answer uses that term. Ask "translate this" with no glossary term in the message or the selection: the line reads "glossary (200 of N)" (the first 200 rows). A very long system prompt (over 32,000 characters): the line ends with "(the prompts are long, so the end was left out)".
6. Change the project prompt or add a glossary row, send again without reopening anything: the next request carries the change.
7. In the AI panel, choose "No project" for the output copy, close both tabs and press "Open translation" again: the output copy's panel still says "No project" (the choice is kept); the source copy's panel still has the project.
8. "Remove from list" the translation project (Home > Projects or the chip's menu), then press "Open translation" again: it is not added back, and no translation line appears after a send.
9. Ordinary project folder: send a request with it chosen. No "Translation context sent" line appears and the answer behaves as before (its instructions only).
10. On the project screen, switch the translation project to "use without instructions": the next request shows no translation line and carries no prompts or glossary.
11. Put `.ieumoffice/instructions.md` with some text into a translation project made before this change (not yet a listed project) and open the translation view: the view opens, the folder is not added to the project list, and no trust dialog appears. Add it through "Add folder" to see the normal trust dialog.
12. Remove a translation project from the translation list (with and without deleting the folder): it also disappears from the project list.

## OCR with the signed-in AI (Task 10b)

Task 10b adds the OCR window (`OcrSelectDialog`) and its channels; Task 11 mounts it in the translation view. Until then, mount it from a dev build (or after Task 11) for a project with a scanned PDF of a few pages and two PNG/JPEG images, OCR set to "AI (Claude)". Watch the subscription's usage: each chosen page is one AI call.

1. Open the window for the scanned PDF: every page is listed ("Page 1" ...), none is checked, "Chosen: 0 of N" shows and "Next" is disabled with the hint "Choose at least one to continue."
2. "Select all" checks every page and the count reads N of N; "Clear selection" unchecks them and "Next" is disabled again.
3. Check pages 1 and 3, press "Next": the confirmation reads "Pages or files to read: 2 (one AI call each)", "AI used: Claude …", "The chosen page images are sent to this AI." Nothing has been sent yet (no usage change, no program started).
4. "Back" returns to the list with the same pages checked; "Cancel" closes the window. In both cases nothing was sent.
5. Press "Start": the window shows "Reading… x of 2", then "Done. The text read is saved as <name> (OCR).docx in the output folder." The file is in the project's `output/` folder, opens in Word or the app, and holds the text of pages 1 and 3 only, in page order. Run it again: the second file is `<name> (OCR) (2).docx`; the first file is unchanged.
6. "Stop" while it reads: no further page is sent; when some pages were read the document holds those and the window says it stopped early.
7. Switch the project's OCR to "Off": opening the window shows "OCR is off for this project…" and lists nothing.
8. Switch the OCR to "AI (ChatGPT)" with only the ChatGPT direct connection (or only Codex) signed in: the confirmation names that connection, not Claude, even when the app-wide "AI to use" is Claude. The app-wide choice in Settings is unchanged afterwards.
9. Sign the chosen AI out: the confirmation shows the connect card and "Start" stays disabled; nothing switches to another AI.
10. A metered Claude login accepted in Settings: the confirmation adds "Claude will charge for this". Not accepted: the connect card shows and "Start" is disabled.
11. Fresh profile where the first-connection notice was never acknowledged: the home screen's first-connection dialog comes up and "Start" stays disabled until it is acknowledged.
12. Two images: the list shows their file names in the order given, the confirmation counts only the checked ones, and the document holds their text in that order.
13. While one OCR run of a project is reading, open the window for the same project again: it says OCR is already running for this project.
14. Stop after at least one page was read: a partial `<name> (OCR).docx` is still written to `output/` with the pages read so far, and the done screen says "OCR stopped early. What was read before is saved."
15. Usage per page: each selected page may be sent more than once. A malformed answer is asked again once, and a timeout, network or overload error is retried once, so in the worst case one page costs about 4 calls. Check the subscription usage against this when testing.
16. Paid login chosen through the project: with the project's OCR set to "AI (Claude)" and only an accepted metered Claude login available, the confirmation shows "Claude will charge for this" before anything is sent. The project's explicit OCR provider counts as the person's own choice; this is flagged for the owner's confirmation.
17. Open the OCR window and pick pages, then switch the project's OCR to "Off" (or to the other AI) in the project settings, and press Next and Start: nothing is sent and the window says OCR is off (or that the window expired or the OCR setting changed).
18. Close the app window while OCR is reading: opening the OCR window for the same project again works at once, without "already running". Then repeat with a reload instead of closing: the run stays held, so opening the OCR window again says OCR is already running until the run ends or 30 minutes of idleness pass. Check that this wait is acceptable.

## PDF, scan and image sources (Task 11)

Which AI is used: the text-PDF translation uses the app's "AI to use" from Settings (the same route as the PDF editor's document translation, a key provider only when the person chose it there, labelled as paid). The OCR of scans and images uses the AI chosen in the project's OCR setting. The confirmation says so.

Use a project with target language German (or any of the 21 app languages except Arabic, Hebrew and Hindi, which the translated-PDF writer cannot lay out), a short text PDF (2-3 pages), a scanned PDF (pages that are pictures only), a PNG image and, for the glossary check, a glossary file with a term from the PDF. Watch the subscription's usage: each batch of text blocks is one AI call (with up to two resends of blocks that came back wrong), each OCR page one call.

1. Text PDF, "Open translation": no tab opens. The "Translate the PDF" window shows "Reading the document…", then the confirmation: "Translate into: German", "AI calls: about N (P of T text blocks)", "AI used: …", "The document's text, with the project's prompts and matching glossary entries, is sent to this AI." and the "Bilingual" option. Nothing is sent yet (no usage change, no program started).
2. "Cancel" closes the window; nothing was sent and `output/` is unchanged.
3. "Start": "Translating… x of T blocks", then "Writing the translated PDF…", then "Done. The translation is saved as <name>.de.pdf in the output folder." The split view opens: the source PDF read-only on the left, the translated PDF on the right. The translated PDF has the same pages with the text in German.
4. Glossary and prompts: with a global system prompt, a project prompt and a glossary entry for a term in the PDF, the translated PDF uses the glossary's term. (Optional: a debug proxy or the provider's history shows the request's system text ending with "Translation project set up by the person", the prompts in `<translation-context>` and the entries in `<translation-glossary>`.)
5. Bilingual: start again with "Bilingual" checked. The result is `<name>.de.bilingual.pdf`: each original page with its translation beside it.
6. "Open translation" on the PDF again: the translation window opens at "An earlier result exists", naming the newest result in the current target language. With everything translated it offers "Open it" (opens the file beside the source without any AI call) and "Translate again". "Translate again" shows the confirmation with "Everything is translated again from the start…" and the full call count, sends every block again with the current prompts and glossary, and writes `<name>.de (2).pdf`. The earlier file is unchanged. Change the project's target language: the earlier German result is no longer offered.
7. Stop while it translates: the window says how many blocks are done. "Write what is done" writes the PDF with the rest in the source language and opens it; "Continue later" closes. Starting again shows the blocks done before as "not sent again" and sends only the rest.
8. Sign the AI out (or pick a key provider and refuse it): the confirmation shows the connect card and "Start" stays disabled; nothing moves to another AI. A key provider or an accepted metered login shows "<provider> will charge for this".
9. Fresh profile where the first-connection notice was never acknowledged: pressing "Open translation" on the PDF brings up the home screen's first-connection dialog over the translation screen, and "Start" stays disabled until it is acknowledged. Do the same with a scanned PDF (the OCR window's confirmation).
10. Project target language that is not one of the app's 21 languages (edit `project.json` by hand, e.g. `"targetLang": "tlh"`): the window says the PDF translation cannot translate into that language.
11. Scanned PDF, "Open translation": the project's source list now shows it as a scan (`project.json` has `"kind": "scan"`). The OCR window opens (Task 10b checks apply). When it finishes, the source PDF opens read-only on the left and `<name> (OCR).docx` on the right; translate the Word document with the AI panel (the translation context line appears, Task 10a).
12. PNG image, "Open translation": the OCR window lists the image; when it finishes, `<name> (OCR).docx` opens alone (no editor shows an image, so there is no left pane).
13. Switch the project's OCR to "Off" and press "Open translation" on the scan or the image: "OCR is off for this project…" shows, no window opens and nothing is written to `output/`.
14. Source PDF pane: try to highlight, add a note or delete a page in the read-only source PDF, then wait for autosave (30 s) and use File > Save: the source copy in `source/` is unchanged (compare its hash or modified time). The translated PDF on the right saves normally.
15. While one PDF translation of a project runs, start another one of the same project (another source): it says a translation is already running for this project.
16. A PDF with a password as a source: "Open translation" ends with "The PDF translation could not be completed." and nothing is written.
17. Scan detection: a 2-page text PDF with a blank last page opens as a text PDF; a PDF where exactly half the pages are pictures opens as a text PDF; one where most pages are pictures opens as a scan.
18. The source row of a PDF shows "Text PDF" or "Scanned PDF" with "Treat as scanned PDF" / "Treat as text PDF". Switch a scan to a text PDF, then "Open translation": the PDF translation window opens. Restart the app and open it again: it stays a text PDF (the choice is remembered in `.tandem/source-kinds.json` for that copy).
19. "Write what is done" that fails (for example the output folder made read-only): the window shows the error; closing it frees the project at once (a new translation of the same project starts without "already running").
20. A stop because of a usage limit or a sign-out names the reason in words (not a code); a sign-out shows the connect card in the stopped window.
21. Stopped translation, then Continue: start a long PDF and press Stop (or hit a usage limit), choose "Continue later". Press "Open translation" again: the window says how many blocks are already translated and offers "Continue (N blocks left)" as the main button. Its confirmation counts only the blocks left (and says the others are not sent again); after Start only those are sent, with the current prompts and glossary, and the finished PDF has every block translated.
22. Stopped "Translate again": choose "Translate again", stop it partway, then open it again: "Continue" is offered for the blocks the restart had not done yet; what it finished is kept.

## Final review fixes

1. Move a project folder in the file manager: the row shows "Folder not found" with "Locate folder…". Pick the moved folder: the row is usable again under the new path. Copy a project folder elsewhere and use "Open existing project folder" on the copy: it is added and opens. Pick an ordinary folder: "This folder is not a translation project." shows and nothing is added.
2. Put an `AGENTS.md` or `.ieumoffice/` memory from elsewhere into a copied project folder, then "Open existing project folder": the project is added with the note that the AI panels do not use its translation context yet; it does not appear in Projects until added there by hand.
3. Make the app-settings file unwritable, create a project: the error shows and the project folder is not left behind; restore the file and create the same name again: it works (no "already exists").
4. Add `a.docx`, translate it, remove it from the sources, add the same file again: it is listed as `a (2).docx` and "Open translation" starts a fresh copy in `output/` (the old `output/a.docx` is untouched).
5. Add sources of each type: `.xls`, `.xlsm`, `.csv`, `.tsv`, `.xmind`, `.json` are accepted and open in their editors; `.ods`, `.odp`, `.gif`, `.webp`, `.bmp`, `.tif` are refused with the message that lists the supported types. The add-source dialog filter offers the same list.
6. In Excel save a glossary as "Unicode Text (*.txt)" (UTF-16 with a byte-order mark) and add it: the entries read correctly (no garbage). A damaged `.xlsx` glossary shows "The glossary file could not be read…" instead of the generic error.
7. Text PDF with a system prompt, a project prompt, a glossary over 200 entries and two reference files: the confirmation lists "System prompt…: yes", "Project prompt: yes", the entry count with the per-block note and the two reference names, before Start; the same list stays while it runs. Nothing is sent before Start.
8. Open a source in the translation view (both panes) and a project document in a detached window, then "Remove from list and delete folder": it is refused with "Documents from this project are open…" and the folder is untouched. Close them and delete again: the folder goes. "Remove from list only" works while they are open.
9. The user guide tab loads the shell's preload too: in its developer console `await window.translateApi.list()` is refused ("this window cannot use the translation tool"), while the home screen's list works.

## Translation follow-ups, Task 2: run-preserving translation

1. Translation project with a Word source that has mixed run formats (italic words, a different font inside a sentence, Hanja runs), footnote references between runs and empty paragraphs. "Open translation", then ask the AI panel to translate the whole document. The activity chips show "Read text runs …" and "Translate blocks"/"Translated N paragraph(s)", never "Replace content".
2. After it finishes: the italic and differently styled words are still styled (the translated words in their place carry the same format), every footnote number is in the same paragraph as before, the empty paragraphs are still there with their old spacing, and no paragraph changed its style (Home > Styles shows the same style per paragraph as the source).
3. Footnote text: open a footnote; the AI translated it through `read_runs` (`notes:true`) and `translate_blocks` (entries with `note` and `id`), and the note id is unchanged and its number still matches. Every footnote and endnote is in the target language. The run ends only after the AI called `read_runs` with `checkRemaining:true` and it reported nothing left (the activity list shows that read as the last step).
4. Undo after the run: one Ctrl+Z per translate_blocks call restores the source text with the same formatting. The panel's roll-back button restores the whole document.
5. With Review > Track Changes on, translate again: each translated run shows the source struck through and the translation inserted with the same formatting; Accept All leaves the same document as with tracking off.
6. Save, reopen in Word: the document opens without a repair prompt and shows the same formatting. Known engine issue (see findings): in a document with "balance single-byte and double-byte character width" (HWP-exported files) a run with letter spacing in an edited paragraph saves a scaled, fractional w:spacing value; check whether Word complains.
7. Footnote formatting: open the saved file in Word and look at footnotes whose text had more than one format (italic title, a hyperlink, a different font). Each format should still sit on the translated words of its run (the app repairs the engine's per-note text patch at save, `note-run-save.ts`); note any footnote where it collapsed into one format.
8. Spacing and tool choice (real run): in the translated body and notes look for double spaces between words, a space before a comma or full stop, and words run together (a date, a word before a bracket). A whitespace-only run between two text runs is never shown to the AI and counts as the space there. The activity list should show `translate_blocks` for the notes too, not `edit_note` or `apply_ops` (those are for small fixes).
8. Spacing: search the translated file for a space before a comma, period or closing bracket (` ,` ` .` ` )`); there should be none the AI did not write.

## Translation follow-ups, Task 1: recent documents

1. Open two sources of a translation project in the translation view, go back to Home > Translation: the recent list shows both above the projects, newest first, one row per project and file.
2. Click a recent row: the split view reopens on that source and its `output/` copy. A PDF, scan or image row opens through the usual PDF/OCR choice dialog; nothing is sent before that dialog's Start.
3. Remove the source from the project (or delete `source/<file>` by hand): the row shows as unavailable and does not open. Moving the project folder and locating it again makes its rows usable again.
4. Open more than ten documents: the list keeps the newest ten. Restart the app: the list is still there.

## Translation follow-ups, Task 2: Word engine check

1. Known engine issue (`docs/tracking/findings.md`, fractional `w:spacing`): translate an HWP-exported docx (with "balance single-byte and double-byte character width") whose heading runs have letter spacing, save, open in Word. Note whether Word offers to repair the file and whether the edited paragraphs' letter spacing differs from the source.

## Translation follow-ups, Task 3: reference material

1. Add a `.docx`, a `.pdf` with a text layer and a `.md` as references: each shows "Converted to text", and "View converted text" opens the read-only text.
2. Add a scanned PDF or an image as a reference: it shows "Needs OCR" and nothing is sent for it.
3. Copy in a project folder from elsewhere whose `references/` holds a link to a file outside the project: that reference shows its outside state and the app neither reads, writes nor deletes it.
4. Edit a converted reference's source by hand, then ask the AI panel something: the index is rebuilt (the excerpt reflects the edit).
5. Ask the AI panel to translate a paragraph that uses a term found in one reference: the translation-context notice counts references, and the answer uses the reference's wording (excerpts reach the AI under `<translation-references>`).

## Translation follow-ups, Task 4: fixed context (decision 0103)

1. Send two requests in one AI panel chat of a translation project: both still carry the full prompts and editing rules (the saving is off; no request shows only `fixed-context: …`). The second request's glossary entries follow its own text.

## Translation follow-ups, Task 5: pictures need OCR

1. Add a `.docx` (and a `.pptx` reference) with a few photos or screenshots: next to each row the detail screen says how many pictures it holds, that their text is not translated, and that OCR is needed (export the pages as PNG/JPEG or a scanned PDF and add that as a document). A document without pictures, a PDF and an image source show no such notice.

## Translation follow-ups, Task 6: notes visible, spacing tidied by the tool

1. Translate a document with footnotes (real run): every read_runs body result and translate_blocks result states the footnote/endnote counts and what is still untranslated; the AI translates the notes without being asked and never says the document has none.
2. In the result look for a space before `, . ) ]` and double spaces: none. French `; : ! ?` and `« »` spacing the AI wrote is left as written. The AI does not use findReplace or ask permission for spacing.

## Translation follow-ups, Task 7: stale build, seam spaces, note wording

1. Before any real run: `npm run build:all`. Real run 4 loaded `apps/docs/out` built before the notes tools existed (old `read_runs` schema without `notes`, old prompt line "translate footnote text with read_notes and edit_note"), which explains the unreachable notes and the missing space tidy. `e2e/translate-real-run.spec.ts` now refuses to start when `apps/docs/out` or `apps/shell/out` is older than its `src`.
2. In the next real run on the footnote document: the AI calls `read_runs notes:true`, then `translate_blocks` entries with `note` and `id`; `read_notes` (if it calls it) ends with that exact call form. No claim that edit_note is forbidden.
3. Look for a space before `, . ) ]` and for double spaces right after a footnote mark or where a source blank run sat between runs ("services;  in", "the score ."): none. Replaying run 4's translate_blocks inputs on its source with the current code left 6 of these (now covered by `translate-spacing-seams.test.ts`).
4. Known gap: when the model writes no space where the source had none between two runs ("a dancer" + "in many ways"), the words run together; the tool cannot tell that from a name split across runs.

## Sheets AI: OCR of a workbook's own pictures (popup overlay, then placement in the chat)

Needs a rebuild of the shell app (`npm run build:all`): main, preload and both renderers changed. No real AI is used by the automated tests; steps 4 to 9 spend a little of your subscription quota.

Webtoon scenario (`US_마계의 달!_22화 2.xlsx`: header A1 이미지 / B1 OCR / C1 번역, 36 pictures from A7 downward, B and C empty beside each):

1. Open the workbook (save it first if it is new) and, in the sheets AI panel, ask "OCR the pictures in this workbook". The AI calls `ocr_pictures` (list), then says in one or two sentences how many pictures it found and where they are anchored, that a popup lets you choose them and confirm the start, and that nothing is sent before you confirm. It does not ask where the text should go yet, and never asks you to attach, unzip, rename, save or order pictures.
2. A dim overlay appears over the sheets window itself. Check: the active tab is still the sheet (no Home tab, no project detail screen, no project list), the number of tabs and windows is unchanged (no extra window), and the status line says it is waiting for you.
3. In the overlay choose "Read all" (or pick some pictures; previews are local and the list shows each anchor cell, for example Sheet1 · A7). Switch to another tab and back: the overlay is still there. Press Start in the confirmation (the existing quota confirmation: count, AI, "pictures are sent").
4. When reading ends the overlay closes by itself and you are on the same sheet. A short line "OCR finished: 36 pictures read" appears as your message and the AI continues: it shows a short preview of what was recognised (count, the first lines, sound effects such as "툭").
5. The AI asks where the text goes with a numbered card (ask_choice): the first option is marked recommended and reads like "put each picture's text in column B on the picture's anchor row, one cell per picture"; other placements follow (another empty column, a new sheet), "Only keep the text as reference" is last, and you can type your own wording.
6. If the text suggests it, it asks one follow-up at a time: one cell per picture or one row per speech bubble, include sound effects or not, bubble reading order, and whether to fill column C with the translation. It does not ask what the header row already tells it (B1 is OCR, C1 is 번역).
7. Pick the recommended option. The AI reads the target cells first; they are empty, so it writes column B on each picture's anchor row (B7, B82, ...) and reports the count. Column A pictures and every other cell are unchanged; Undo reverts the whole write.
8. Repeat the request and answer "Only keep the text as reference": nothing is written. Repeat once more with a filled cell in column B: the AI shows the filled cells and asks overwrite / skip / another column before writing anything.
9. Ask again and press Cancel (or close the sheets tab) while the overlay or the reading is open: the status line stops waiting, nothing is written, and (Activity Monitor / Task Manager) no claude or codex child process stays running.
10. Asking twice while the overlay is open does not create a second overlay. A workbook opened from a project's source/output folder uses that project; any other workbook uses a private copy under `<userData>/ocr-chat`, which never appears in the translation project list. An unsaved new workbook, a password-protected one, a CSV or a converted .xls is refused with a plain message. With unsaved edits the AI offers to save first and opens the overlay only after you say so.
11. Copies under `<userData>/ocr-chat` older than 7 days are removed at the next app start or the next private copy. A sheets window that is a detached window gets the overlay over that window; the main window is not raised.

## Sheets AI: waiting state while the OCR popup is open

Needs a rebuild of the shell app (`npm run build:all`): main, preload and the sheets and shell renderers changed.

1. In the sheets AI panel ask to OCR the workbook's pictures. After the AI opens the popup, the panel's status line says it is waiting for you (not "finished").
2. Finish or cancel the overlay: the waiting line is gone (on Cancel at once; after a finished reading the AI's next turn starts and the line shows running).
3. Run any other AI request: the status line shows running, then finished, as before.

## Translation: Save as… (a copy of the translated document)

Needs a rebuild of the shell app (`npm run build:all`): main, preload and the shell renderer changed.

1. Open a translation of a `.docx` (then the same for `.xlsx`, `.md`, `.html`): the tab strip shows "Save as…" next to the hide/show buttons. Click it: a native save dialog opens in the project folder with the name `<original name> (<target language code>)` and the original extension.
2. Save it elsewhere (for example the Desktop) and open it in Word or Excel: it is the translated document in the same format, equal to the output file. A "Translation saved." line shows on the strip for a few seconds.
3. Cancel the dialog: nothing is written and no message shows. Pick a name that exists: the dialog's own overwrite question appears first.
4. Edit the translation without saving, then click Save as…: no dialog; the strip says to save in the editor first. Save with Ctrl+S, use Save as… again: the saved content is copied.
5. In the save dialog go into the project's `source` folder and save: the app refuses with a plain message and writes nothing. Choosing the project's `output` file itself is refused as well.
6. Project detail screen: each source row has "Save as…". Before the translation was ever opened it says there is no translation to save yet. For a text PDF translated earlier it saves a copy of the newest translated PDF as a PDF; for an OCR result it saves the Word document.
7. The strip button is the only Save as… for the translation; the old "Export translation" wording is gone in your screen language. Hover the button: its tooltip names the output file.
8. Right-click the output tab and choose Save As: the same copy dialog opens (not the editor's own Save As), and the pane stays on the project's output file afterwards. The same menu entry on the source tab does nothing.
9. The editor's own Save As inside the output pane (File menu, ribbon, Ctrl/Cmd+Shift+S; try docx, xlsx, pptx, md, html, hwp, epub, mindmap, pdf) opens the same copy dialog as the strip button, in the same format (no ODT or other format choice), and the pane stays on the project's output file. With unsaved edits the strip asks you to save first. In the source pane the same entries do nothing. An ordinary document's Save As is unchanged.

## Translation: output is read-only while the AI translates

Needs a rebuild of the shell app (`npm run build:all`): main, preload, the docs and sheets renderers and the shared UI changed.

1. Open a translation of a `.docx`, ask the AI in the output pane to translate. While it runs a banner "The AI is translating; editing is locked until it finishes" shows at the bottom of the output pane and typing or clicking in the text does nothing (docs: the editor is read-only; the AI's own edits still appear). When the run ends the banner goes and typing works.
2. Same for an `.xlsx` translation: cells cannot be selected or edited while the AI runs (the grid is inert), the AI's writes still land, and the grid is editable again afterwards.
3. Press Stop in the AI panel mid-run: the lock lifts at once. Start another run and press "Unlock" on the banner: the run stops and the pane is editable. Cause an error (disconnect the subscription program): the lock lifts.
4. Ask the sheets AI to OCR a picture so the OCR popup opens: while it waits for you the sheet is editable (waiting is not locked); once the AI carries on it locks again. The AI re-reads paragraph fingerprints, so an edit you made in the waiting time is refused rather than overwritten.
5. An ordinary document (not opened from a translation project) with the AI running is never locked and shows no banner. The source pane keeps its own read-only guard.
6. Leave a run silent for 5 minutes (for example by pulling the network mid-run): the lock lets go on its own.


## Translation view: AI assistant open/closed per pane

Needs a rebuild of the shell app (`npm run build:all`): main, preload, the docs and sheets renderers and the shared UI changed.

1. Open a `.docx` translation. The output pane (editable) shows its AI assistant open; the source pane (read-only) shows only the small AI icon.
2. Click into the source text, then back into the output: the source assistant never opens by itself, and the output assistant stays open the whole time (it no longer folds to the icon when the source has focus).
3. Press the AI icon (or the ribbon AI Assistant button) in the source pane: the assistant opens. Press it in the output pane while the source has focus: the output gets focus and its panel stays open. Close the output panel with its own button: it stays closed through focus switches.
4. Repeat with an `.xlsx` translation (copilot panel). Also check an ordinary split of two documents: the unfocused pane still folds to the icon as before.
5. The output pane's assistant is open every time a translation view opens, even if you had closed the AI panel in normal documents before. Close it by hand and it stays closed for that view; switching panes does not reopen it.
6. Press the AI button in the source pane, click the composer and type a sentence: the text appears (it used to be swallowed by the read-only guard). Typing in the source document itself, and Ctrl+S, are still refused. Other editors' composers use the same path; check one (for example a markdown translation) if you can.

## Translation view: source and output tabs are one group

Needs a rebuild of the shell app (`npm run build:all`): main and the tab strip renderer changed.

1. Open a `.docx` translation. The two tabs sit side by side with a shared accent line along their top edge and no hairline between them.
2. Close the output tab (X, middle click, Ctrl/Cmd+W, right-click Close): both tabs close. Reopen and close the source tab: both close.
3. Type in the output so it has unsaved changes, then close either tab: the save/discard prompt appears once. Cancel keeps both tabs open; Save or Don't save closes both.
4. Right-click a tab of the pair, "Close other tabs": the pair stays, other tabs close. "Close all tabs" closes the pair with one prompt at most.
5. Drag one tab of the pair along the strip: both move together and never get another tab between them. A plain split of two unrelated documents shows no bracket and still closes independently.
6. Hide the source with the pane toggle: the pair stays grouped; the toggle still works.
7. Quit and restart with the translation view open: it returns as a pair (source read-only, same bracket). If you delete the output file while the app is closed, the restart does not show a lone source tab.
8. The output tab of a pair has "Open in new window" off (a pair cannot be torn off).

## Translation: project list and project detail screens (visual polish)

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`).

1. Project list: the title, intro and the New project / Open existing buttons sit in one header. Projects are cards (name, language pair chip, Documents and References counts, last opened time, a quiet Delete). Recent documents form one bordered list below, the global system prompt is a card at the end, and "Saved" appears as a chip beside its label. With no projects, a dashed card shows one line and the New project button.
2. Project detail: back link, title with the language pair chip and Start translation in the header (the disabled hint sits under it). Languages, Documents to translate, Reference material, Glossary, Project prompt and OCR are one card each; Add files is in each card header with a count chip; Save as... and Open translation stay on each document row; reference states show as chips.
3. Check light and dark themes and a narrow window (row buttons wrap under the file name), keyboard Tab focus rings on cards, rows and buttons, and a reference that needs OCR (red-tinted chip plus the note under the name).

## Translation pair tabs: selecting a tab never mixes documents

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`).

1. Open a translation pair A, then an ordinary document B. B shows alone (full width); A's two tabs stay side by side in the strip.
2. Click A's output, A's source, then B again. A shows its own two panes each time; B always shows alone, never beside a pane of A.
3. Open a second translation pair B and click all four tabs in turn. Each pair shows exactly its own source and output, never one pane from each pair.

## AI asks through a numbered question card (ask_choice)

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`). Uses a real AI turn (your subscription limit).

1. In any editor's AI panel, ask for something with a real choice, for example "put the summary somewhere in this document" and say nothing about where. The AI should call the question tool: the status line reads "waiting for you" and, once the AI finished its sentence, a card appears above the composer with the question, numbered options and a "Type your own answer" row.
2. Press a number key with the composer empty (and with focus on the card): the option is chosen, your chat bubble reads "2 · <option text>" (not a `[choice:...]` tag) and the AI continues using that answer. Typing digits into the document or into a composer that already has text must not choose anything.
3. Repeat and type your own answer then Enter (a Korean or Japanese IME's Enter that commits composing text must not send); repeat and press Esc or Skip: the AI continues with a safe default or asks once in prose, and the bubble reads "Skipped the question".
4. While the card is shown, type an ordinary message in the composer and send it: the card disappears.
5. Check light and dark themes, a narrow panel, Tab order (card, options, typing row, Skip) and that the card does not animate under the OS "reduce motion" setting. Reopen the chat history: the answer bubble still reads in its readable form.


## Translation screens: table look, writing style, rename, title opens the document

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`). Check in light and dark.

1. Project list: a header row (Name, Languages, Documents, References, Last opened) over full-width rounded rows with a folder icon, the name over a shortened folder path, the language chip, counts and relative time. Newest opened comes first. Click Name, then Name again, then Last opened: the order and the chevron follow. Leave the list and come back: the order is kept until the app quits.
2. Hover a row: it highlights and a "..." button appears on the right. Click anywhere on the row: the project opens. Tab to a name, press Up/Down: focus moves between rows; Enter opens. Narrow the window below about 800 px: the count columns disappear.
3. Row menu: "Rename" edits the name in the row (Enter or leaving the field saves, Escape cancels, an empty or 81-character name shows the notice and changes nothing). "Delete" keeps the two-step confirmation. A project whose folder moved shows "Locate folder..." and "Remove from list" in its menu.
4. Rename a project, then check the folder on disk keeps its old name, the Recent documents table shows the new project name, and reopening the app still shows the new name.
5. Project detail: the title has a pencil (or click the title) to rename in place; "Saved" appears next to it. The three file blocks are tables (Name, Status); icons per file type; hover a row for the icon buttons (save as, open translation, delete, OCR, treat as scan/text, view converted text) and read their tooltips.
6. Click a document's name in "Documents to translate": the translation view opens (same as the arrow button). A PDF scan still shows the OCR confirmation; with several documents "Start translation" stays disabled and shows the hint.
7. Writing style card: choose "With Oxford comma" and "Inside the quotes": "Saved" appears. Open the translation view and ask the AI panel to show its instructions (or read `.tandem/project.json`): the Writing style rule is in the project context, and not there when both are "Follow the target language's usual convention". Type a custom instruction, leave the field: it is saved and sent as "Custom instruction: ...".
8. An existing project made before this change opens with both writing style options on "Follow the target language's usual convention".
9. Italics (needs a rebuild of the shell and docs apps; real AI turns). A NEW project's writing style card shows "Italics" on "Apply automatically (titles, foreign terms, scientific names)"; a project made before this change shows "Follow the source (no rule)". In a new project translate a Korean Word document into English that mentions a book (『동학』 or a quoted title), a film, a Korean word kept in romanised form (hanbok) and a Latin species name: those spans come out italic in the English text, titles of articles stay in quotation marks, plain emphasis is not italicised, and no literal `<i>` or `</i>` is visible anywhere. A bold run keeps its bold under the italic span. With track changes ON the inserted text shows as an insertion and the italic span is inside it. Set "Do not add italics": a new translation has no italics of the AI's own (italics that the source run had are kept). Translate into Korean with "Apply" on: nothing is italicised. Run a review (감수) on a correct translation with "Apply" on: no tracked change is made only to italicise (an italic-only change of unchanged words is skipped by design); a wrong word the AI replaces with a title may arrive italic. Use add_bilingual: the added translation carries the italic spans, the original is untouched. Save as .docx and open it in Word: the italic spans are italic, the neighbouring text keeps its font and bold. Not yet checked with a real Word round trip.

## Translation project: kept answers and the three questions

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`). Uses real AI turns (your subscription limit).

1. New translation project, open a document and ask the AI to translate it. Before writing, the AI should ask the output mode as a numbered card (1 overwrite the output copy, 2 keep the original and add the translation beside it) with "Use this for the rest of the project" ticked-able. Pick 2 with the box ticked: the AI then asks the bilingual layout (parentheses after the term, translation after the paragraph, two columns or adjacent cell, adapted to the editor) and only then writes.
2. Ask for another translation in the same project: neither question comes again. Open the project screen: the "Translation choices" card lists the output mode and the layout. Reset one item: only that row goes back to "Not decided yet", and the next translation asks that question again.
3. Open an ordinary (non-translation) document and trigger a question: the card has no "rest of the project" box.
4. A scan or picture OCR run in the chat (Word or any non-sheets editor): after you reviewed the recognised text the AI asks where it goes as a numbered card, the recommended place first and "Only keep the text as reference" last; choosing the reference option writes nothing into the document. In the sheets AI panel the picture OCR still opens its popup with its own placement dialog (unchanged).
5. Look at the card in light and dark themes and a narrow window (the answer text moves under the name).


## Sheets picture OCR popup: order, enlarging, text in drawings, failures

Needs a rebuild of the shell and sheets apps. Uses ONE real AI picture-read at a time (your subscription limit). Use a copy of the webtoon workbook.

1. Open the workbook in Sheets, ask the AI to read the text in the pictures. The popup lists "Picture 1 ... N" top to bottom with the sheet and anchor cell (A7, A82, A157 ...). A workbook whose pictures were added out of order still lists them by anchor row.
2. Press the magnifier on a row: a large preview opens inside the popup. Left/Right (or the arrow buttons) move between pictures; Esc closes only the preview; "Actual size" switches from fit-to-width (a tall strip scrolls vertically) to real pixels with drag panning. Nothing is sent to the AI by this.
3. Choose picture 1 (speech bubbles), Next, Start. The bubble text ("리루, 네 침대 밑에 이런 게 있던데....") should come back in the chat message. Before this change a picture of art came back with 0 characters and no error.
4. Choose a blank picture (for example picture 29): the popup must say "Picture 29 (...): no text found in this picture." with "Retry these pictures" and "Continue with what was read"; no silent success.
5. Disconnect or sign out of the AI program and start again: the failure shows per picture with its reason, and "Retry these pictures" runs only those after the usual confirmation.


## Translation project: bilingual output (add_bilingual)

Needs a rebuild of the shell app (`npm run build -w @genoffice/shell`). Uses real AI turns (your subscription limit). Use a copy of a Word document that has body paragraphs, a heading, a list, a footnote, a plain table, and a second copy with a merged-cell table.

1. New translation project, pick "keep the original and add the translation beside it". In a paragraph-only part: the translation should appear as a new paragraph right after each original with the same style and run formatting; the original paragraphs, empty paragraphs and footnote marks are unchanged, and no footnote mark is duplicated in the new paragraphs. The tool card reads "Added N bilingual paragraph(s)".
2. Ask for the same range again: nothing is added twice (the result says the paragraphs already have their translation). Ask "is anything left untranslated": the AI should not list the originals or the added paragraphs. Footnotes are left in the original language and the AI says so.
3. Plain table: the AI must ask the direction EVERY time (right cell: left original, right translation; below cell: top original, bottom translation), with no "use this for the rest of the project" box. Choose right: a new column appears right of each text column, with the same fill and borders, the table keeps its total width, originals untouched. Ask again for another document with a table: it asks again. Choose below: a new row under each text row, same fill and borders.
4. Table with merged cells: choose right. The AI tells you it fell back to rows below because of the merged cells; each row group tied by merges is repeated as one block right after the group with the same merges, and the grid is not broken (open the saved file in Word to check).
5. Track changes on: the added paragraphs, rows and cells show as insertions by the AI author; reject all returns the original document.
6. Undo once after one add_bilingual call restores the document before it. A numbered heading (numbering from the heading style) gets its twin numbered too: note it if it looks wrong.


## Translation review (감수): revise_blocks with tracked changes

Needs a rebuild of the shell and docs apps (`npm run build -w @genoffice/shell`). Uses real AI turns (your subscription limit). Use a translation project whose output copy is already translated (a Word document with mixed run formatting, a footnote, a table, an empty paragraph), and one bilingual output.

1. Open the translation view and the AI panel empty state: a sixth starter "Review the translation..." (in your language) sits after the other translation starters. Click it: the composer is filled with the review instruction and nothing is sent.
2. Send it with the panel's track-changes switch OFF. While the AI runs the output is locked; afterwards the changes still show as tracked changes whose author is "AI Assistant (review)" (check the review pane filter by author). Only the wrong words are marked deleted/inserted, not whole paragraphs; italic, bold and font of each run are unchanged; the footnote mark and empty paragraphs are unchanged.
3. Accept one change and reject another: the text follows. Undo once after a revise call restores the text before it. Save, reopen the file in Word: the revisions and their author survive and can be accepted there.
4. Comments: non-trivial fixes and doubts have one short comment with the reason; trivial fixes have none; ask for the review again: no identical comment is added twice. Neither the file in `source/` nor the original is changed.
5. Original comparison: the AI says where it read the original (the file in `source/` through project_read, or the bilingual twin). Check it catches a deliberately wrong number, a dropped sentence and a glossary term you changed in the output. With an unreadable original (for example a scan) it says so and reviews fluency and consistency only.
6. Bilingual output: only the translation next to each original is revised; the original paragraphs are never changed (a revise call on one is refused).
7. A paragraph you left untranslated is reported as not revised (with the source language known), and the AI offers to translate it. After the review, "is anything left untranslated" does not list the reviewed paragraphs.
8. Footnotes and endnotes carry no tracked changes: the AI only mentions doubts about them in the summary. Finish: the summary gives counts by kind of fix and the open doubts.
9. An ODT document: the review tool is not offered (tracked changes are off there).


## Bilingual output anywhere: add_bilingual with an explicit target

Needs a rebuild of the shell and docs apps. Uses real AI turns (your subscription limit). Use Word documents with tables; keep the originals to compare.

1. Worksheet with pre-made columns (image / OCR / translation): ask for the translation while keeping the original, answer the table question with "an existing empty cell next to the original" and say which column ("column C"). The translation lands in the empty cells of that column, nothing is added, the original cells are unchanged, and the cell keeps its own alignment and borders.
2. A table with an empty row under each original row: choose "an existing empty cell next to the original (below)". Each translation fills the empty cell below its original; no new row appears.
3. Choose "somewhere else" and type a place (a cell of another table, "after the last paragraph", "before the title"). The AI follows it literally; the original stays.
4. A table with merged cells: a destination that is the top-left cell of a merge is written; a coordinate inside a merge gets an error naming the anchor and the AI retries there. Out-of-range coordinates are refused with the table size.
5. A destination cell that already has text is refused unless you tell the AI to replace it; replacing with track changes ON is refused (the text could not be marked deleted), with it OFF the text is replaced.
6. Track changes ON: the written text shows as an insertion by the AI author, in the existing cell and in new paragraphs. One undo restores the whole call.
7. Afterwards "is anything left untranslated" lists neither the originals nor the cells you filled, and a repeated request does not write the same translation twice. Save, reopen in Word: cell content and formatting are as shown.
