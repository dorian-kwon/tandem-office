# Projekty tłumaczeniowe

Projekt tłumaczeniowy gromadzi w jednym folderze dokumenty, które chcesz przetłumaczyć, materiały referencyjne i glosariusz, a AI za każdym razem dostaje te same instrukcje. AI pomaga tłumaczyć dokumenty Word i inne, a tekstowy plik PDF potrafi przetłumaczyć na nowy PDF.

## Co zawiera projekt

- **Źródło**: dokumenty do przetłumaczenia. Aplikacja trzyma własną kopię w folderze `source/` projektu; wybrany przez Ciebie plik nigdy nie jest otwierany ani zmieniany.
- **Materiały referencyjne**: materiały pomocnicze, takie jak wcześniejsze tłumaczenia czy przewodniki stylu.
- **Glosariusz**: terminy, które zawsze trzeba tłumaczyć tak samo.
- **Wynik**: tłumaczenia, które piszesz, w folderze `output/` projektu.

## Trzy ekrany

1. **Lista projektów**: otwórz **Tłumaczenie** na pasku bocznym ekranu głównego. Tu tworzysz, otwierasz i usuwasz projekty oraz piszesz globalny prompt systemowy, który obowiązuje w każdym projekcie tłumaczeniowym.
2. **Szczegóły projektu**: języki, prompt projektu (dodatkowe instrukcje tylko dla tego projektu), listy dokumentów do przetłumaczenia, materiałów referencyjnych i glosariusza oraz wybór sposobu odczytu zeskanowanych stron (OCR). **Otwórz tłumaczenie** przy dokumencie rozpoczyna pracę.
3. **Widok tłumaczenia**: kopia źródłowa po lewej, Twoje tłumaczenie po prawej, obok siebie. Panel źródła jest tylko do odczytu. **Ukryj źródło** i **Ukryj tłumaczenie** oddają całe okno drugiemu panelowi, a panel wraca w to samo miejsce.

## Glosariusz

- Dodaj plik `.csv`, `.xlsx` lub `.txt` (w `.txt` kolumny rozdzielone są tabulatorami). Każdy wiersz to jeden termin.
- Kolumny to termin źródłowy, tłumaczenie i opcjonalnie uwaga. Pierwszy wiersz jest pomijany tylko wtedy, gdy nazywa pierwsze dwie kolumny (na przykład source i target albo term i translation); każdy inny pierwszy wiersz jest czytany jako wpis glosariusza.
- Pliki są czytane jako UTF-8, a jeśli nie są poprawnym UTF-8, jako CP949, dzięki czemu koreańskie pliki ze starszych programów wyświetlają się poprawnie.
- Do 200 wpisów wysyłanych jest w całości. Powyżej 200 wysyłane są tylko wpisy, których termin źródłowy występuje w tłumaczonym tekście.

## Pliki referencyjne

- Wraz z żądaniem tłumaczenia wysyłane są tylko nazwy plików referencyjnych, bez ich zawartości.
- Gdy trzeba, AI może przeczytać plik referencyjny za pomocą narzędzi projektu.

## Skanowane PDF-y i obrazy (OCR)

- Skanowany PDF lub obraz nie ma jeszcze tekstu do tłumaczenia, więc AI najpierw go odczytuje. W szczegółach projektu wybierz, które AI odczytuje: **AI (Claude)**, **AI (ChatGPT)** lub **Wyłączone**. Gdy jest wyłączone, skanów i obrazów nie można otworzyć do tłumaczenia.
- Strony do odczytu wybierasz pojedynczo lub przyciskiem **Zaznacz wszystko**. Odczytywane są tylko wybrane strony.
- Obrazy stron są wysyłane do AI dopiero po Twoim potwierdzeniu na ekranie kontrolnym, który pokazuje, ile stron zostanie wysłanych i które AI zostanie użyte. Może to zużyć limit Twojego abonamentu, a połączenie płatne jest przed wysłaniem oznaczone jako płatne.
- Odczytany tekst jest zapisywany jako dokument Word w folderze wyjściowym. Przetłumacz ten dokument w widoku tłumaczenia za pomocą panelu AI.
- Obsługiwane są obrazy PNG i JPEG. Nie są obsługiwane obrazy GIF, BMP, TIFF i WebP, obrazy powyżej 20 MB ani PDF-y chronione hasłem.

## Tłumaczenie PDF

- Tekstowy PDF jest tłumaczony na nowy PDF w folderze wyjściowym. Możesz też wybrać dwujęzyczny PDF, z tłumaczeniem obok każdej oryginalnej strony.
- Ekran kontrolny pokazuje liczbę wywołań AI i używane AI, zanim cokolwiek zostanie wysłane. Tłumaczenie tekstowych PDF-ów używa ogólnoaplikacyjnego **AI do użycia** z Ustawień, a OCR używa AI wybranego w projekcie.
- Jeśli się zatrzyma, **Zapisz to, co gotowe** zapisuje to, co przetłumaczono. Gdy ponownie otworzysz dokument, naciśnij **Kontynuuj**, aby wysłać tylko pozostałe bloki.

## Ograniczenia

- Zmian w panelu źródła nie można zapisać. W niektórych edytorach można pisać w pamięci, ale plik w `source/` nie jest zapisywany.
- **Przetłumacz ponownie** tłumaczy wszystko od początku, ale zachowuje bloki, które sam edytowałeś w widoku dwujęzycznym edytora PDF.
- Arabski, hebrajski i hindi nie mogą być językiem docelowym przetłumaczonego PDF.
- Okno pozostawione otwarte przez długi czas wygasa; otwórz je ponownie z poziomu projektu.
