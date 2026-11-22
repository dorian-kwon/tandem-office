import type { zh } from './zh'

export const en = {
  ocrLanguage: 'Recognition language',
  ocrLanguageDefault: 'System default',
  ocrLanguageUnavailable:
    'The selected recognition language is unavailable. Choose another language or install it on this device.',
  ocrTitle: 'Run OCR',
  ocrBatch: 'Run batch OCR',
  ocrPdf: 'Searchable PDF',
  ocrWord: 'Editable Word',
  ocrRunning: 'Recognizing text…',
  ocrNoText: 'No readable text was found.',
  ocrUnavailable: 'Local OCR is unavailable on this device.',
  title: 'File conversion',
  chooseFiles: 'Choose files',
  outputFormat: 'Output format',
  convert: 'Convert',
  converting: 'Converting…',
  destinationHint:
    'Each converted file is saved beside its original. If a name is taken, a number is added to the new file name.',
  noCommonFormat:
    'These files have no output format in common. Remove some files or choose others.',
  chooseFailed: 'Could not open the file picker.',
  convertFailed: 'Could not finish converting the files.',
  saved: 'Saved',
  failed: 'Conversion failed',
  removeFile: 'Remove {name} from the list',
  ocrRange: 'Pages to recognize',
  ocrAllPages: 'All pages',
  ocrRangeInvalid: 'Check the page range for this file. Example: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
