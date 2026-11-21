import type { zh } from './zh'

export const cs = {
  title: 'Převod souborů',
  chooseFiles: 'Vybrat soubory',
  outputFormat: 'Výstupní formát',
  convert: 'Převést',
  converting: 'Probíhá převod…',
  destinationHint:
    'Každý převedený soubor se uloží do složky původního souboru. Pokud je název již obsazený, přidá se k názvu nového souboru číslo.',
  noCommonFormat:
    'Vybrané soubory nemají společný výstupní formát. Odeberte některé soubory ze seznamu nebo vyberte jiné.',
  chooseFailed: 'Okno pro výběr souborů se nepodařilo otevřít.',
  convertFailed: 'Převod souborů se nepodařilo dokončit.',
  saved: 'Uloženo',
  failed: 'Převod se nezdařil',
  removeFile: 'Odebrat {name} ze seznamu',
} satisfies Record<keyof typeof zh, string>
