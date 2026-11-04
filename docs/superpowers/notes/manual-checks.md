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

## Sheets AI: OCR of a workbook's own pictures opens the OCR popup

Needs a rebuild of the shell app (`npm run build:all`): main, preload and both renderers changed.

1. Open a workbook with floating pictures (for example the webtoon sheet: headers image / OCR / translation, pictures anchored in column A from row 7, columns B and C empty). In the sheets AI panel ask "OCR the pictures in this workbook".
2. The AI calls `ocr_pictures` (chat line "N pictures found"), then says in one or two sentences how many pictures it found and where they are anchored, that it will propose a destination next to them, and that nothing is sent until you confirm. It does not ask you to attach, unzip, rename, save or order pictures, and does not point you to the agent window.
3. The app switches to the home tab and the OCR selection popup shows the pictures with local previews (check the count and the anchor cells in the list against the sheet). Nothing is sent to the AI provider yet; confirm the start (the existing quota confirmation) and later the placement dialog, which should recommend the empty column beside each picture (column B).
4. The original workbook is unchanged (the result is a new file). A workbook opened from a project source/output folder uses that project; any other workbook uses a private copy under `<userData>/ocr-chat`. An unsaved new workbook, a password-protected one, a CSV or a converted .xls is refused with a plain message in the chat.
5. Pictures added since the last save are not listed (the popup reads the saved file); the AI says so.
6. With unsaved edits in the workbook, ask for the OCR again: the AI does not open the popup, offers to save first, and opens it after you save and say so.
7. Close the popup (Cancel) for a workbook outside any project: the home tab shows the translation project list, not a project detail screen for a hidden folder.
8. Copies under `<userData>/ocr-chat` older than 7 days are removed at the next app start or the next private copy. The sheets AI panel never mentions a "document_ocr" chat flow (only the popup).

## Sheets AI: waiting state while the OCR popup is open

Needs a rebuild of the shell app (`npm run build:all`): main, preload and the sheets and shell renderers changed.

1. In the sheets AI panel ask to OCR the workbook's pictures. After the AI opens the popup, the panel's status line says it is waiting for you (not "finished").
2. Finish or cancel the popup on the home tab, then return to the sheets tab: the waiting line is gone (it clears when the popup closes, even if the sheets tab was in the background).
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
9. Known gap: the editor's own File > Save As inside the output pane still behaves as in a normal document (the pane moves to the copy, and can pick a format such as ODT). Use the strip button or the tab menu for a safe copy; check whether this gap bothers you.

## Translation: output is read-only while the AI translates

Needs a rebuild of the shell app (`npm run build:all`): main, preload, the docs and sheets renderers and the shared UI changed.

1. Open a translation of a `.docx`, ask the AI in the output pane to translate. While it runs a banner "The AI is translating; editing is locked until it finishes" shows at the bottom of the output pane and typing or clicking in the text does nothing (docs: the editor is read-only; the AI's own edits still appear). When the run ends the banner goes and typing works.
2. Same for an `.xlsx` translation: cells cannot be selected or edited while the AI runs (the grid is inert), the AI's writes still land, and the grid is editable again afterwards.
3. Press Stop in the AI panel mid-run: the lock lifts at once. Start another run and press "Unlock" on the banner: the run stops and the pane is editable. Cause an error (disconnect the subscription program): the lock lifts.
4. Ask the sheets AI to OCR a picture so the OCR popup opens: while it waits for you the sheet is editable (waiting is not locked); once the AI carries on it locks again. The AI re-reads paragraph fingerprints, so an edit you made in the waiting time is refused rather than overwritten.
5. An ordinary document (not opened from a translation project) with the AI running is never locked and shows no banner. The source pane keeps its own read-only guard.
6. Leave a run silent for 5 minutes (for example by pulling the network mid-run): the lock lets go on its own.

