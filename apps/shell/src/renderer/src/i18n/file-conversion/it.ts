import type { zh } from './zh'

export const it = {
  ocrLanguage: 'Lingua di riconoscimento',
  ocrLanguageDefault: 'Predefinita di sistema',
  ocrLanguageUnavailable:
    'La lingua selezionata non è disponibile. Scegli un’altra lingua o installala sul dispositivo.',
  ocrTitle: 'Esegui OCR',
  ocrBatch: 'Avvia OCR in batch',
  ocrPdf: 'PDF ricercabile',
  ocrWord: 'Word modificabile',
  ocrRunning: 'Riconoscimento del testo…',
  ocrNoText: 'Nessun testo leggibile trovato.',
  ocrUnavailable: 'OCR locale non disponibile su questo dispositivo.',
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
  ocrRange: 'Pagine da riconoscere',
  ocrAllPages: 'Tutte le pagine',
  ocrRangeInvalid: 'Verifica le pagine selezionate per questo file. Esempio: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
