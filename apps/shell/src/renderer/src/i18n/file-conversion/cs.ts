import type { zh } from './zh'

export const cs = {
  ocrLanguage: 'Jazyk rozpoznávání',
  ocrLanguageDefault: 'Výchozí nastavení systému',
  ocrLanguageUnavailable:
    'Vybraný jazyk není dostupný. Vyberte jiný nebo jej nainstalujte do zařízení.',
  ocrTitle: 'Spustit OCR',
  ocrBatch: 'Spustit dávkové OCR',
  ocrPdf: 'Prohledávatelné PDF',
  ocrWord: 'Upravitelný Word',
  ocrRunning: 'Rozpoznávání textu…',
  ocrNoText: 'Nebyl nalezen čitelný text.',
  ocrUnavailable: 'Místní OCR není na tomto zařízení dostupné.',
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
  ocrRange: 'Stránky k rozpoznání',
  ocrAllPages: 'Všechny stránky',
  ocrRangeInvalid: 'Zkontrolujte rozsah stránek tohoto souboru. Příklad: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
