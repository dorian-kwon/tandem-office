import type { zh } from './zh'

export const de = {
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
} satisfies Record<keyof typeof zh, string>
