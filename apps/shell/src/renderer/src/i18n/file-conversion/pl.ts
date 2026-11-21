import type { zh } from './zh'

export const pl = {
  title: 'Konwersja plików',
  chooseFiles: 'Wybierz pliki',
  outputFormat: 'Format wyjściowy',
  convert: 'Konwertuj',
  converting: 'Konwertowanie…',
  destinationHint:
    'Każdy przekonwertowany plik jest zapisywany w folderze oryginału. Jeśli nazwa jest już zajęta, do nazwy nowego pliku zostanie dodany numer.',
  noCommonFormat:
    'Wybrane pliki nie mają wspólnego formatu wyjściowego. Usuń niektóre pliki z listy lub wybierz inne.',
  chooseFailed: 'Nie udało się otworzyć okna wyboru plików.',
  convertFailed: 'Nie udało się ukończyć konwersji plików.',
  saved: 'Zapisano',
  failed: 'Błąd konwersji',
  removeFile: 'Usuń {name} z listy',
} satisfies Record<keyof typeof zh, string>
