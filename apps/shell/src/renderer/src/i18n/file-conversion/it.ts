import type { zh } from './zh'

export const it = {
  title: 'Conversione file',
  chooseFiles: 'Scegli file',
  outputFormat: 'Formato di destinazione',
  convert: 'Converti',
  converting: 'Conversione in corso…',
  destinationHint:
    'Ogni file convertito viene salvato nella cartella del relativo originale. Se il nome è già in uso, al nome del nuovo file viene aggiunto un numero.',
  noCommonFormat:
    'I file selezionati non hanno un formato di destinazione in comune. Rimuovi alcuni file dall’elenco o scegline altri.',
  chooseFailed: 'Impossibile aprire la finestra di selezione dei file.',
  convertFailed: 'Impossibile completare la conversione dei file.',
  saved: 'Salvato',
  failed: 'Conversione non riuscita',
  removeFile: 'Rimuovi {name} dall’elenco',
} satisfies Record<keyof typeof zh, string>
