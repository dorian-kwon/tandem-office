import type { zh } from './zh'

export const en = {
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
} satisfies Record<keyof typeof zh, string>
