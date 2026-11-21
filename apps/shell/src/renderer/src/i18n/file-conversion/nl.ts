import type { zh } from './zh'

export const nl = {
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
} satisfies Record<keyof typeof zh, string>
