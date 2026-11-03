# Übersetzungsprojekte

Ein Übersetzungsprojekt hält die Dokumente, die Sie übersetzen möchten, Ihr Referenzmaterial und ein Glossar in einem Ordner zusammen und gibt der KI jedes Mal dieselben Anweisungen. Die KI hilft Ihnen beim Übersetzen von Word- und anderen Dokumenten und kann ein Text-PDF in ein neues PDF übersetzen.

## Was ein Projekt enthält

- **Quelle**: die zu übersetzenden Dokumente. Die App legt eine eigene Kopie im Ordner `source/` des Projekts ab; die von Ihnen gewählte Datei wird nie geöffnet oder verändert.
- **Referenzen**: Hintergrundmaterial wie frühere Übersetzungen oder Stilrichtlinien.
- **Glossar**: die Begriffe, die immer gleich übersetzt werden müssen.
- **Ausgabe**: die Übersetzungen, die Sie schreiben, im Ordner `output/` des Projekts.

## Die drei Ansichten

1. **Projektliste**: Öffnen Sie **Übersetzung** in der Seitenleiste der Startseite. Hier erstellen, öffnen und löschen Sie Projekte und schreiben den globalen System-Prompt, der für jedes Übersetzungsprojekt gilt.
2. **Projektdetails**: die Sprachen, der Projekt-Prompt (zusätzliche Anweisungen nur für dieses Projekt), die Listen mit Dokumenten, Referenzen und Glossar sowie die Auswahl zum Lesen gescannter Seiten (OCR). Mit **Übersetzung öffnen** bei einem Dokument beginnt die Arbeit.
3. **Übersetzungsansicht**: links die Quellkopie, rechts Ihre Übersetzung, nebeneinander. Der Quellbereich ist schreibgeschützt. **Quelle ausblenden** und **Übersetzung ausblenden** geben dem anderen Bereich das ganze Fenster, und der Bereich kehrt an dieselbe Stelle zurück.

## Glossar

- Fügen Sie eine `.csv`-, `.xlsx`- oder `.txt`-Datei hinzu (bei `.txt` sind die Spalten durch Tabulatoren getrennt). Jede Zeile ist ein Begriff.
- Die Spalten sind der Ausgangsbegriff, die Übersetzung und optional eine Anmerkung. Eine erste Zeile wird nur übersprungen, wenn sie die ersten beiden Spalten benennt (zum Beispiel source und target oder term und translation); jede andere erste Zeile wird als Glossareintrag gelesen.
- Dateien in UTF-16 (zum Beispiel „Unicode-Text“ aus Excel) werden erkannt. Andere Dateien werden als UTF-8 gelesen, und als CP949, wenn sie kein gültiges UTF-8 sind, sodass koreanische Dateien älterer Programme richtig angezeigt werden.
- Bis zu 200 Einträge werden vollständig gesendet. Bei mehr als 200 werden nur die Einträge gesendet, deren Ausgangsbegriff im zu übersetzenden Text vorkommt.

## Referenzdateien

- Wenn Sie eine Referenzdatei hinzufügen, wandelt die App sie in Text um (abgelegt in `references/.md/`; die Datei selbst wird nie geändert) und indiziert ihre Wörter. Die Stellen werden nach den Wörtern Ihrer Nachricht und des markierten Texts gewählt (im KI-Bereich, einmal beim Senden) oder nach den Wörtern des übersetzten Abschnitts (im PDF-Fenster); nur die gewählten Stellen gehen mit, höchstens 6.000 Zeichen, zusammen mit den Dateinamen. Ist der gesamte Referenztext nicht länger, geht er vollständig mit.
- In den Projektdetails zeigt jede Referenz ihren Zustand: **In Text umgewandelt** (mit **Umgewandelten Text ansehen** schreibgeschützt öffnen), **OCR nötig** (ein Scan oder Bild: daraus wird nichts gesendet; fügen Sie es als zu übersetzendes Dokument hinzu, lesen Sie es per OCR und fügen Sie das entstandene Word-Dokument als Referenz hinzu) oder **Nicht lesbar**.
- Bei Bedarf kann die KI eine Referenzdatei über die Projektwerkzeuge lesen.

## Gescannte PDFs und Bilder (OCR)

- Ein gescanntes PDF oder ein Bild enthält noch keinen zu übersetzenden Text, daher liest die KI es zuerst. Wählen Sie in den Projektdetails, welche KI liest: **KI (Claude)**, **KI (ChatGPT)** oder **Aus**. Ist sie aus, lassen sich Scans und Bilder nicht zum Übersetzen öffnen.
- Sie wählen die zu lesenden Seiten einzeln oder mit **Alle auswählen**. Nur die gewählten Seiten werden gelesen.
- Die Seitenbilder werden erst an die KI gesendet, wenn Sie im Prüfbildschirm bestätigen. Er zeigt, wie viele Seiten gesendet werden und welche KI verwendet wird. Dabei kann das Kontingent Ihres Tarifs verbraucht werden, und eine kostenpflichtige Verbindung wird vor dem Senden als kostenpflichtig gekennzeichnet.
- Der gelesene Text wird als Word-Dokument im Ausgabeordner gespeichert. Übersetzen Sie dieses Dokument in der Übersetzungsansicht mit dem KI-Bereich.
- PNG- und JPEG-Bilder werden unterstützt. GIF-, BMP-, TIFF- und WebP-Bilder, Bilder über 20 MB und passwortgeschützte PDFs nicht.
- Enthält ein Dokument oder eine Referenzdatei Bilder (Word, PowerPoint, Excel, OpenDocument, HWPX oder EPUB), zeigt die Projektansicht neben der Datei, wie viele. Text in diesen Bildern gehört nicht zum Text des Dokuments und wird daher weder übersetzt noch gesendet. Zum Lesen ist OCR nötig, aber OCR liest nur gescannte PDFs und Bilddateien, keine Bilder in einer anderen Datei: Exportieren oder kopieren Sie die Seiten mit Bildern als PNG- oder JPEG-Bild oder als gescanntes PDF, fügen Sie es als zu übersetzendes Dokument hinzu und lesen Sie es per OCR. Sehr kleine Bilder (unter 2 KB, etwa Aufzählungszeichen) und Bilder in PDFs werden nicht gezählt.

## PDF-Übersetzung

- Ein Text-PDF wird in ein neues PDF im Ausgabeordner übersetzt. Sie können auch ein zweisprachiges PDF wählen, bei dem die Übersetzung neben jeder Originalseite steht.
- Der Prüfbildschirm zeigt die Anzahl der KI-Aufrufe und die verwendete KI, bevor etwas gesendet wird. Die Übersetzung von Text-PDFs nutzt die appweite **zu verwendende KI** aus den Einstellungen, die OCR dagegen die im Projekt gewählte KI.
- Wird sie gestoppt, speichert **Fertiges schreiben** das bisher Übersetzte. Öffnen Sie das Dokument erneut und drücken Sie **Fortsetzen**, um nur die übrigen Blöcke zu senden.

## Grenzen

- Änderungen im Quellbereich lassen sich nicht speichern. In manchen Editoren können Sie im Speicher tippen, die Datei in `source/` wird aber nicht geschrieben.
- **Erneut übersetzen** übersetzt alles von vorn, behält aber Blöcke, die Sie in der zweisprachigen Ansicht des PDF-Editors selbst bearbeitet haben.
- Arabisch, Hebräisch und Hindi können nicht Zielsprache eines übersetzten PDFs sein.
- Ein lange geöffnet gelassenes Fenster läuft ab; öffnen Sie es erneut im Projekt.
