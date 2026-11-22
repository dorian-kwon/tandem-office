import type { zh } from './zh'

export const pl = {
  ocrLanguage: 'Język rozpoznawania',
  ocrLanguageDefault: 'Domyślny język systemu',
  ocrLanguageUnavailable:
    'Wybrany język jest niedostępny. Wybierz inny lub zainstaluj ten język na urządzeniu.',
  ocrTitle: 'Uruchom OCR',
  ocrBatch: 'Uruchom wsadowe OCR',
  ocrPdf: 'PDF z możliwością wyszukiwania',
  ocrWord: 'Edytowalny dokument Word',
  ocrRunning: 'Rozpoznawanie tekstu…',
  ocrNoText: 'Nie znaleziono czytelnego tekstu.',
  ocrUnavailable: 'Lokalne OCR jest niedostępne na tym urządzeniu.',
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
  ocrRange: 'Strony do rozpoznania',
  ocrAllPages: 'Wszystkie strony',
  ocrRangeInvalid: 'Sprawdź zakres stron tego pliku. Przykład: 1, 3–5',
} satisfies Record<keyof typeof zh, string>
