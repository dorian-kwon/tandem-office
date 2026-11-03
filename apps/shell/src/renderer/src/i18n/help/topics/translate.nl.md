# Vertaalprojecten

Een vertaalproject houdt de documenten die je wilt vertalen, je referentiemateriaal en een woordenlijst samen in één map en geeft de AI elke keer dezelfde instructies. De AI helpt je bij het vertalen van Word- en andere documenten en kan een tekst-PDF vertalen naar een nieuwe PDF.

## Wat een project bevat

- **Bron**: de te vertalen documenten. De app bewaart een eigen kopie in de map `source/` van het project; het bestand dat je koos wordt nooit geopend of gewijzigd.
- **Referenties**: achtergrondmateriaal, zoals eerdere vertalingen of stijlgidsen.
- **Woordenlijst**: de termen die altijd op dezelfde manier vertaald moeten worden.
- **Uitvoer**: de vertalingen die je schrijft, in de map `output/` van het project.

## De drie schermen

1. **Projectlijst**: open **Vertaling** in de zijbalk van Start. Hier maak, open en verwijder je projecten en schrijf je de globale systeemprompt, die voor elk vertaalproject geldt.
2. **Projectdetails**: de talen, de projectprompt (extra instructies alleen voor dit project), de lijsten met te vertalen documenten, referenties en woordenlijst, en de keuze voor het lezen van gescande pagina’s (OCR). **Vertaling openen** bij een document start het werk.
3. **Vertaalweergave**: de bronkopie links en jouw vertaling rechts, naast elkaar. Het bronvenster is alleen-lezen. **Bron verbergen** en **Vertaling verbergen** geven het hele venster aan het andere deel, en het deel keert terug waar je het had gelaten.

## Woordenlijst

- Voeg een `.csv`-, `.xlsx`- of `.txt`-bestand toe (bij `.txt` worden de kolommen door tabs gescheiden). Elke rij is één term.
- De kolommen zijn de bronterm, de vertaling en eventueel een opmerking. Een eerste rij wordt alleen overgeslagen als die de eerste twee kolommen benoemt (bijvoorbeeld source en target, of term en translation); elke andere eerste rij wordt als glossariumitem gelezen.
- Bestanden die als UTF-16 zijn opgeslagen (bijvoorbeeld "Unicode-tekst" uit Excel) worden herkend. Andere bestanden worden als UTF-8 gelezen, en als CP949 wanneer ze geen geldige UTF-8 zijn, zodat Koreaanse bestanden van oudere programma’s goed te zien zijn.
- Tot 200 items worden volledig verstuurd. Bij meer dan 200 worden alleen de items verstuurd waarvan de bronterm in de te vertalen tekst voorkomt.

## Referentiebestanden

- Als je een referentiebestand toevoegt, zet de app het om naar tekst (bewaard in `references/.md/`; het bestand zelf wordt nooit gewijzigd) en indexeert de woorden. De delen worden gekozen op de woorden van je bericht en de geselecteerde tekst (in het AI-paneel, eenmaal bij verzenden) of van de reeks die wordt vertaald (in het PDF-venster), en alleen de gekozen delen gaan mee, tot 6.000 tekens, samen met de bestandsnamen. Is alle referentietekst samen niet langer, dan gaat die helemaal mee.
- In de projectdetails toont elk referentiebestand zijn status: **Omgezet naar tekst** (open het met **Omgezette tekst bekijken**, alleen-lezen), **OCR nodig** (een scan of afbeelding: er wordt niets van verstuurd; voeg het toe als te vertalen document, lees het met OCR en voeg het resulterende Word-document toe als referentie) of **Kan niet worden gelezen**.
- Als dat nodig is, kan de AI een referentiebestand lezen via de projecthulpmiddelen.

## Gescande pdf’s en afbeeldingen (OCR)

- Een gescande pdf of een afbeelding heeft nog geen tekst om te vertalen, dus de AI leest die eerst. Kies in de projectdetails welke AI leest: **AI (Claude)**, **AI (ChatGPT)** of **Uit**. Als dit uit staat, kunnen scans en afbeeldingen niet worden geopend om te vertalen.
- Je kiest de te lezen pagina’s, een voor een of met **Alles selecteren**. Alleen de gekozen pagina’s worden gelezen.
- De paginabeelden worden pas naar de AI gestuurd nadat je hebt bevestigd op het controlescherm, dat laat zien hoeveel pagina’s worden verstuurd en welke AI wordt gebruikt. Het kan het tegoed van je abonnement gebruiken, en een betaalde verbinding wordt als betaald aangeduid voordat er iets wordt verstuurd.
- De gelezen tekst wordt als Word-document in de uitvoermap opgeslagen. Vertaal dat document in de vertaalweergave met het AI-paneel.
- PNG- en JPEG-afbeeldingen worden ondersteund. GIF-, BMP-, TIFF- en WebP-afbeeldingen, afbeeldingen groter dan 20 MB en pdf’s met wachtwoord niet.
- Als een document of referentiebestand afbeeldingen bevat (Word, PowerPoint, Excel, OpenDocument, HWPX of EPUB), toont het projectdetail hoeveel naast dat bestand. Tekst in die afbeeldingen hoort niet bij de tekst van het document en wordt dus niet vertaald of verstuurd. Om die te lezen is OCR nodig, maar OCR leest alleen gescande pdf’s en afbeeldingsbestanden, geen afbeeldingen in een ander bestand: exporteer of kopieer de pagina’s met afbeeldingen als PNG- of JPEG-afbeelding of als gescande pdf, voeg die toe als te vertalen document en lees die met OCR. Heel kleine afbeeldingen (onder 2 KB, zoals opsommingstekens) en afbeeldingen in pdf’s worden niet meegeteld. Alleen afbeeldingen die in de inhoud staan tellen: achtergronden van diamodellen en -indelingen, ongebruikte media en voorbeeldweergaven van vergelijkingen tellen niet. Helemaal niet herkend worden tekst-pdf’s, de oude binaire formaten (doc, xls, ppt, hwp) en tekst die als vormen, WordArt of SmartArt is getekend; geen melding betekent dus niet dat een bestand geen tekst in afbeeldingen heeft.

## PDF-vertaling

- Een tekst-pdf wordt vertaald naar een nieuwe pdf in de uitvoermap. Je kunt ook een tweetalige pdf kiezen, met de vertaling naast elke originele pagina.
- Het controlescherm toont het aantal AI-aanroepen en welke AI wordt gebruikt voordat er iets wordt verstuurd. Tekst-pdf-vertaling gebruikt de app-brede **te gebruiken AI** uit de Instellingen, terwijl OCR de AI gebruikt die in het project is gekozen.
- Als het stopt, slaat **Voltooide deel schrijven** op wat vertaald is. Open het document opnieuw en druk op **Verdergaan** om alleen de resterende blokken te versturen.

## Beperkingen

- Wijzigingen in het bronvenster kunnen niet worden opgeslagen. In sommige editors kun je in het geheugen typen, maar het bestand in `source/` wordt niet geschreven.
- **Opnieuw vertalen** vertaalt alles vanaf het begin, maar houdt blokken die je zelf hebt bewerkt in de tweetalige weergave van de pdf-editor.
- Arabisch, Hebreeuws en Hindi kunnen niet de doeltaal van een vertaalde pdf zijn.
- Een venster dat lang openstaat, verloopt; open het opnieuw vanuit het project.
