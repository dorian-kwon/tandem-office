# Translation review needed

The translation-project strings and help topic exist in 21 languages. Korean and English were written by hand. The other 19 languages (ar, cs, de, es, fr, he, hi, id, it, ja, ms, nl, pl, pt, ru, th, vi, zh, zh-TW) were drafted by an AI and have not been read by a native speaker. They need a native-speaker review before release.

What to look at: natural wording, consistent terms (project, glossary, reference, source, output, "AI to use"), and the placeholders `{n}`-style tokens staying intact. The right-to-left languages (ar, he) are plain text with no direction markers, like the neighbouring files.

Files, per language `<lang>`:

- `apps/shell/src/renderer/src/i18n/translate/<lang>.ts` (161 keys: project list, detail, translation view, OCR, PDF translation)
- `packages/ui/src/strings-project-panel/<lang>.ts` (only the `translation*` keys at the end: ja, zh, zh-TW, ar, he, hi, ru and th were drafted earlier; cs, de, es, fr, id, it, ms, nl, pl, pt and vi in this task)
- `apps/shell/src/renderer/src/i18n/help/topics/translate.<lang>.md` (help topic "Translation projects")
- the topic title in `apps/shell/src/renderer/src/i18n/help/help-titles.ts` (`translate`)

Added in the final review fix (same files, same 19 drafted languages):

- `apps/shell/src/renderer/src/i18n/translate/<lang>.ts`: new keys `openExisting`, `locateFolder`, `adoptNotLinked`, `errProjectInUse`, `errGlossaryInvalid`, `ctxTitle`, `ctxSystemOn`, `ctxSystemOff`, `ctxProjectOn`, `ctxProjectOff`, `ctxGlossaryNone`, `ctxGlossaryAll`, `ctxGlossaryPerBlock`, `ctxReferencesNone`, `ctxReferences`; `errUnsupportedSource` gained a "Supported types: ..." sentence (the extension list itself is the same in every language).
- `apps/shell/src/renderer/src/i18n/help/topics/translate.<lang>.md`: the glossary encoding line (UTF-16 such as Excel's "Unicode Text").

Not reviewed here: the product name, which is still open.
