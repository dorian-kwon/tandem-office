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
- Pliki zapisane w UTF-16 (na przykład „Tekst Unicode” z Excela) są rozpoznawane. Pozostałe pliki są czytane jako UTF-8, a jeśli nie są poprawnym UTF-8, jako CP949, dzięki czemu koreańskie pliki ze starszych programów wyświetlają się poprawnie.
- Do 200 wpisów wysyłanych jest w całości. Powyżej 200 wysyłane są tylko wpisy, których termin źródłowy występuje w tłumaczonym tekście.

## Pliki referencyjne

- Po dodaniu pliku referencyjnego aplikacja konwertuje go na tekst (przechowywany w `references/.md/`; sam plik nigdy nie jest zmieniany) i indeksuje jego słowa. Fragmenty są wybierane według słów Twojej wiadomości i zaznaczonego tekstu (w panelu AI, raz przy wysyłaniu) lub tłumaczonej partii (w oknie PDF) i wysyłane są tylko wybrane fragmenty, do 6000 znaków, razem z nazwami plików. Gdy cały tekst referencyjny nie przekracza tej długości, wysyłany jest w całości.
- W szczegółach projektu każdy plik referencyjny pokazuje swój stan: **Przekonwertowano na tekst** (otwórz go przez **Pokaż przekonwertowany tekst**, tylko do odczytu), **Wymaga OCR** (skan lub obraz: nic z niego nie jest wysyłane; dodaj go jako dokument do tłumaczenia, odczytaj przez OCR i dodaj powstały dokument Word jako plik referencyjny) albo **Nie udało się odczytać**.
- Gdy trzeba, AI może przeczytać plik referencyjny za pomocą narzędzi projektu.

## Skanowane PDF-y i obrazy (OCR)

- Skanowany PDF lub obraz nie ma jeszcze tekstu do tłumaczenia, więc AI najpierw go odczytuje. W szczegółach projektu wybierz, które AI odczytuje: **AI (Claude)**, **AI (ChatGPT)** lub **Wyłączone**. Gdy jest wyłączone, skanów i obrazów nie można otworzyć do tłumaczenia.
- Strony do odczytu wybierasz pojedynczo lub przyciskiem **Zaznacz wszystko**. Odczytywane są tylko wybrane strony.
- Obrazy stron są wysyłane do AI dopiero po Twoim potwierdzeniu na ekranie kontrolnym, który pokazuje, ile stron zostanie wysłanych i które AI zostanie użyte. Może to zużyć limit Twojego abonamentu, a połączenie płatne jest przed wysłaniem oznaczone jako płatne.
- Odczytany tekst jest zapisywany jako dokument Word w folderze wyjściowym. Przetłumacz ten dokument w widoku tłumaczenia za pomocą panelu AI.
- Obsługiwane są obrazy PNG i JPEG. Nie są obsługiwane obrazy GIF, BMP, TIFF i WebP, obrazy powyżej 20 MB ani PDF-y chronione hasłem.
- Gdy dokument lub plik referencyjny zawiera obrazy (Word, PowerPoint, Excel, OpenDocument, HWPX lub EPUB), szczegóły projektu pokazują ich liczbę obok tego pliku. Tekst wewnątrz tych obrazów nie jest częścią tekstu dokumentu, więc nie jest tłumaczony ani wysyłany. Aby go odczytać, potrzebny jest OCR, ale OCR czyta tylko zeskanowane pliki PDF i pliki graficzne, a nie obrazy w innym pliku: wyeksportuj lub skopiuj strony z obrazami jako obraz PNG lub JPEG albo zeskanowany PDF, dodaj go jako dokument do tłumaczenia i odczytaj przez OCR. Bardzo małe obrazy (poniżej 2 KB, np. punktory) i obrazy w plikach PDF nie są liczone. Liczą się tylko obrazy umieszczone w treści: tła wzorców i układów slajdów, nieużywane multimedia i podglądy równań nie są liczone. Wcale nie są wykrywane: tekstowe pliki PDF, stare formaty binarne (doc, xls, ppt, hwp) oraz tekst narysowany jako kształty, WordArt lub SmartArt, więc brak powiadomienia nie oznacza, że plik nie ma tekstu na obrazach.

## Tłumaczenie PDF

- Tekstowy PDF jest tłumaczony na nowy PDF w folderze wyjściowym. Możesz też wybrać dwujęzyczny PDF, z tłumaczeniem obok każdej oryginalnej strony.
- Ekran kontrolny pokazuje liczbę wywołań AI i używane AI, zanim cokolwiek zostanie wysłane. Tłumaczenie tekstowych PDF-ów używa ogólnoaplikacyjnego **AI do użycia** z Ustawień, a OCR używa AI wybranego w projekcie.
- Jeśli się zatrzyma, **Zapisz to, co gotowe** zapisuje to, co przetłumaczono. Gdy ponownie otworzysz dokument, naciśnij **Kontynuuj**, aby wysłać tylko pozostałe bloki.

## Ograniczenia

- Zmian w panelu źródła nie można zapisać. W niektórych edytorach można pisać w pamięci, ale plik w `source/` nie jest zapisywany.
- **Przetłumacz ponownie** tłumaczy wszystko od początku, ale zachowuje bloki, które sam edytowałeś w widoku dwujęzycznym edytora PDF.
- Arabski, hebrajski i hindi nie mogą być językiem docelowym przetłumaczonego PDF.
- Okno pozostawione otwarte przez długi czas wygasa; otwórz je ponownie z poziomu projektu.
