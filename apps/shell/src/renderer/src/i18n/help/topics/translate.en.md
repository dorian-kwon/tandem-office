# Translation projects

A translation project keeps the documents you want to translate, your reference material and a glossary together in one folder, and gives the AI the same instructions every time. The AI helps you translate Word and other documents, and it can translate a text PDF into a new PDF.

## What a project holds

- **Source**: the documents to translate. The app keeps its own copy in the project's `source/` folder; the file you picked is never opened or changed.
- **References**: background material such as earlier translations or style guides.
- **Glossary**: the terms that must always be translated the same way.
- **Output**: the translations you write, in the project's `output/` folder.

## The three screens

1. **Project list**: open **Translation** in Home's sidebar. Here you create, open and delete projects, and write the global system prompt, which applies to every translation project.
2. **Project detail**: the languages, the project prompt (extra instructions for this project only), the lists of documents to translate, references and glossary, and the choice for reading scanned pages (OCR). **Open translation** on a document starts the work.
3. **Translation view**: the source copy on the left and your translation on the right, side by side. The source pane is read-only. **Hide source** and **Hide translation** give the other pane the whole window, and the pane comes back where you left it.

## Glossary

- Add a `.csv`, `.xlsx` or `.txt` file (`.txt` columns are separated by tabs). Each row is one term.
- The columns are the source term, the translation and, optionally, a note. A first row with column names is skipped; it is optional.
- Files are read as UTF-8, and as CP949 when they are not valid UTF-8, so Korean files from older programs show correctly.
- Up to 200 entries are sent whole. Above 200, only the entries whose source term appears in the text being translated are sent.

## Reference files

- Only the names of the reference files are sent along with a translation request. Their contents are not.
- When it needs one, the AI can read a reference file through the project tools.

## Scanned PDFs and images (OCR)

- A scanned PDF or an image has no text to translate yet, so the AI reads it first. In the project detail, choose which AI reads it: **AI (Claude)**, **AI (ChatGPT)** or **Off**. When it is off, scans and images cannot be opened for translation.
- You choose the pages to read, one by one or with **Select all**. Only the pages you choose are read.
- The page images are sent to the AI only after you confirm on the check screen, which shows how many pages are sent and which AI is used. It may use your plan's quota, and a paid connection is labelled as paid before anything is sent.
- The text read is saved as a Word document in the output folder. Translate that document in the translation view with the AI panel.
- PNG and JPEG images are supported. GIF, BMP, TIFF and WebP images, images over 20 MB and password-protected PDFs are not.

## PDF translation

- A text PDF is translated into a new PDF in the output folder. You can also choose a bilingual PDF, with the translation beside each original page.
- The check screen shows the number of AI calls and which AI is used before anything is sent. Text PDF translation uses the app-wide **AI to use** from Settings, while OCR uses the AI chosen in the project.
- If it stops, **Write what is done** saves what was translated, and **Continue** later sends only the blocks that are left.

## Limits

- Edits in the source pane cannot be saved. You can type in memory in some editors, but the file in `source/` is not written.
- **Translate again** translates everything from the start, but keeps blocks you edited yourself in the PDF editor's bilingual view.
- Arabic, Hebrew and Hindi cannot be the target language of a translated PDF.
- A window left open for a long time expires; open it again from the project.
