# Manual checks for the translation tool

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
13. Known limits of the source pane's key guard, check they are acceptable: typing is blocked, so a find field opened by the editor inside the source pane (Ctrl/Cmd+F) cannot take a search word; use Find in the right pane or copy text out. On Windows, Alt+letter menu access (e.g. Alt+F) is blocked while the source pane has focus; click the right pane first.
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
18. Close the app window (or reload) while OCR is reading: opening the OCR window for the same project again works at once, without "already running".

## PDF, scan and image sources (Task 11)

Use a project with target language German (or any of the 21 app languages), a short text PDF (2-3 pages), a scanned PDF (pages that are pictures only), a PNG image and, for the glossary check, a glossary file with a term from the PDF. Watch the subscription's usage: each batch of text blocks is one AI call (with up to two resends of blocks that came back wrong), each OCR page one call.

1. Text PDF, "Open translation": no tab opens. The "Translate the PDF" window shows "Reading the document…", then the confirmation: "Translate into: German", "AI calls: about N (P of T text blocks)", "AI used: …", "The document's text, with the project's prompts and matching glossary entries, is sent to this AI." and the "Bilingual" option. Nothing is sent yet (no usage change, no program started).
2. "Cancel" closes the window; nothing was sent and `output/` is unchanged.
3. "Start": "Translating… x of T blocks", then "Writing the translated PDF…", then "Done. The translation is saved as <name>.de.pdf in the output folder." The split view opens: the source PDF read-only on the left, the translated PDF on the right. The translated PDF has the same pages with the text in German.
4. Glossary and prompts: with a global system prompt, a project prompt and a glossary entry for a term in the PDF, the translated PDF uses the glossary's term. (Optional: a debug proxy or the provider's history shows the request's system text ending with "Translation project set up by the person", the prompts in `<translation-context>` and the entries in `<translation-glossary>`.)
5. Bilingual: start again with "Bilingual" checked. The result is `<name>.de.bilingual.pdf`: each original page with its translation beside it.
6. "Open translation" on the PDF again: "An earlier result exists" names the newest result. "Open it" opens it beside the source without any AI call; "Translate again" shows the confirmation with "Everything is already translated. Nothing is sent…" and writes `<name>.de (2).pdf`. The earlier file is unchanged.
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
