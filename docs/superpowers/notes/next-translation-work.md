# Next translation work (queued)

Items the owner asked to handle in the next round of the translation tool.

## 1. Bilingual annotation (병기) translation: ask where to put it

Some source passages need the translation shown next to the original (a term, a title, a name):
`The Paint Man (뺑끼쟁이)` keeps the original in parentheses. Today the AI decides alone
where and how to write this (inline in parentheses, in a footnote, first mention only, every mention).

Wanted: the tool asks the user before translating, then remembers the answer.

- Ask once per project (and let the project prompt hold the answer), not per paragraph:
  - Where to put the original: in parentheses after the translation, before it, in a footnote,
    or not at all (translation only).
  - Which items get it: first mention only or every mention; titles, personal names, technical terms,
    terms from the glossary.
  - Which bracket style to use (the target language's convention).
- Store the choice in the project (next to the project prompt and glossary) and put it in the
  fixed translation context, so every request follows it.
- The AI must follow the stored rule and must not invent its own; if the rule is missing, it asks
  instead of choosing.
- The real run of 2026-11-04 showed the case: footnote 10 kept the Korean title on purpose and the
  model flagged it for review.

Open design points: where the question appears (project detail screen vs first translation),
whether it is a per-language-pair setting, and how it interacts with glossary entries.

## 2. OCR results: ask where to put them

OCR (AI-only, user-selected files) currently turns a scan or a picture's text into text for the
translation, but the user is not asked where that text should end up.

Wanted: after OCR, ask the user where the recognised text goes, then remember the answer per project.

- Options to offer (confirm the list when designing):
  - Into the translated document in place of the picture or scan page.
  - Beside the picture as a caption or text block, keeping the picture.
  - Only into reference material (used as context, not placed in the output).
  - Into a separate file in `output/` (for example a markdown copy) without touching the document.
- Ask per OCR run (it differs by document), with "use this for the rest of the project" as a choice.
- Never place OCR text into the document without that answer, and never modify the original in
  `source/` or `references/`.
- Show what was recognised before placing it, since OCR can be wrong, and keep the existing
  confirmation step for spending OCR quota.

Open design points: how placement works in each editor (docx, pptx, xlsx, hwp, pdf), what happens to
pictures inside documents (the picture notice already tells the user OCR is needed), and whether the
answer is stored with the OCR provider choice in the project settings.

## 3. First translation request: ask overwrite or bilingual (병기)

When the user first asks to translate a document, the tool must ask how the result relates to the original,
instead of silently picking one:

- **Overwrite:** the translation replaces the source text in the output copy (today's behaviour of
  `translate_blocks`).
- **Bilingual (병기):** keep the original and add the translation beside it, for example the translation
  after the original paragraph, original in parentheses after each term, two columns in a table, or the
  translation in the next cell/row for spreadsheets.
- Ask once per document (or per project, with "use this for the rest of the project"), remember the answer
  in the project beside the prompt and glossary, and put it in the fixed translation context so every request
  follows it. Section 1 (where to put the original inside a sentence) is the finer setting under bilingual.
- Without an answer the AI must ask first and must not start writing into the document.
- Per-editor meaning needs design: docx (paragraph after, inline, table), xlsx (adjacent column), pptx
  (second text box or notes), hwp, pdf. Overwrite on the output copy only; `source/` stays untouched.

### OCR example from the owner (2026-11-04)

`US_마계의 달!_22화 2.xlsx` (a webtoon translation worksheet; the file stays outside the repo).

- One sheet, `A1:Z2607`. Header block rows 1-6: `A1` "이미지" (image), `B1` "OCR", `C1` "번역" (translation), `D1` "Instructions"
  (`A1:A6`, `B1:B6`, `C1:C6` merged; `D1:E1` merged).
- 36 episode strips as floating pictures (`xl/media/image1..36.jpg`, one-cell anchors) in column A starting at
  row 7 (rows 7, 82, 157, 232, 275, ...), each about 75 rows tall; the strips are tall comic images with
  Korean speech bubbles and sound effects.
- Columns B and C are empty beside every picture. The sheet layout says: recognised text goes into column B
  next to its picture, the translation into column C.
- Open points to ask the owner: one cell per picture or one row per speech bubble; whether sound effects
  (e.g. "툭") are included; reading order of bubbles; whether images are kept (the header says they may need to
  be deleted when submitting because of size).
- Design consequence for xlsx: "where to put OCR text" is a worksheet position (column and row relative to the
  image anchor), so the placement choice needs a spreadsheet variant: next to the picture's anchor row in a
  chosen column, with optional translation column.
