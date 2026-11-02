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
