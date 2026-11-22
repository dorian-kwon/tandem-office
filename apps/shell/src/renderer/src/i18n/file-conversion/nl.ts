import type { zh } from './zh'

export const nl = {
  ocrLanguage: 'Herkenningstaal',
  ocrLanguageDefault: 'Systeemstandaard',
  ocrLanguageUnavailable:
    'De gekozen herkenningstaal is niet beschikbaar. Kies een andere taal of installeer deze op dit apparaat.',
  ocrTitle: 'OCR uitvoeren',
  ocrBatch: 'Batch-OCR starten',
  ocrPdf: 'Doorzoekbare PDF',
  ocrWord: 'Bewerkbaar Word-document',
  ocrRunning: 'Tekst herkennen…',
  ocrNoText: 'Geen leesbare tekst gevonden.',
  ocrUnavailable: 'Lokale OCR is niet beschikbaar op dit apparaat.',
  title: 'Bestanden converteren',
  chooseFiles: 'Bestanden kiezen',
  outputFormat: 'Uitvoerformaat',
  convert: 'Converteren',
  converting: 'Bezig met converteren…',
  destinationHint:
    'Elk geconverteerd bestand wordt in de map van het origineel opgeslagen. Als de naam al in gebruik is, krijgt het nieuwe bestand een nummer in de naam.',
  noCommonFormat:
    'De geselecteerde bestanden hebben geen gemeenschappelijk uitvoerformaat. Verwijder enkele bestanden uit de lijst of kies andere bestanden.',
  chooseFailed: 'Het venster voor bestandsselectie kon niet worden geopend.',
  convertFailed: 'De conversie van de bestanden kon niet worden voltooid.',
  saved: 'Opgeslagen',
  failed: 'Conversie mislukt',
  removeFile: '{name} uit de lijst verwijderen',
  ocrRange: 'Te herkennen pagina’s',
  ocrAllPages: 'Alle pagina’s',
  ocrRangeInvalid: 'Controleer het paginabereik voor dit bestand. Voorbeeld: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
