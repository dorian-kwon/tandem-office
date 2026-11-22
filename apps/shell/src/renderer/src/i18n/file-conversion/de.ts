import type { zh } from './zh'

export const de = {
  ocrLanguage: 'Erkennungssprache',
  ocrLanguageDefault: 'Systemstandard',
  ocrLanguageUnavailable:
    'Die ausgewählte Sprache ist nicht verfügbar. Wählen Sie eine andere oder installieren Sie die Sprache auf diesem Gerät.',
  ocrTitle: 'OCR ausführen',
  ocrBatch: 'Stapel-OCR starten',
  ocrPdf: 'Durchsuchbare PDF',
  ocrWord: 'Bearbeitbares Word-Dokument',
  ocrRunning: 'Text wird erkannt…',
  ocrNoText: 'Kein lesbarer Text gefunden.',
  ocrUnavailable: 'Lokale OCR ist auf diesem Gerät nicht verfügbar.',
  title: 'Dateikonvertierung',
  chooseFiles: 'Dateien auswählen',
  outputFormat: 'Ausgabeformat',
  convert: 'Konvertieren',
  converting: 'Wird konvertiert…',
  destinationHint:
    'Jede konvertierte Datei wird im Ordner der jeweiligen Originaldatei gespeichert. Ist der Name bereits vergeben, erhält die neue Datei eine Nummer im Namen.',
  noCommonFormat:
    'Für diese Dateien gibt es kein gemeinsames Ausgabeformat. Entfernen Sie einige Dateien aus der Liste oder wählen Sie andere aus.',
  chooseFailed: 'Die Dateiauswahl konnte nicht geöffnet werden.',
  convertFailed: 'Die Konvertierung konnte nicht abgeschlossen werden.',
  saved: 'Gespeichert',
  failed: 'Konvertierung fehlgeschlagen',
  removeFile: '{name} aus der Liste entfernen',
  ocrRange: 'Zu erkennende Seiten',
  ocrAllPages: 'Alle Seiten',
  ocrRangeInvalid: 'Prüfen Sie den Seitenbereich dieser Datei. Beispiel: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
