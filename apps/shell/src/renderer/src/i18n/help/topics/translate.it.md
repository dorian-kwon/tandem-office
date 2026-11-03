# Progetti di traduzione

Un progetto di traduzione raccoglie in un’unica cartella i documenti da tradurre, il materiale di riferimento e un glossario, e dà ogni volta all’IA le stesse istruzioni. L’IA ti aiuta a tradurre documenti Word e di altri formati, e può tradurre un PDF di testo in un nuovo PDF.

## Che cosa contiene un progetto

- **Origine**: i documenti da tradurre. L’app tiene una copia propria nella cartella `source/` del progetto; il file che hai scelto non viene mai aperto né modificato.
- **Riferimenti**: materiale di supporto, come traduzioni precedenti o guide di stile.
- **Glossario**: i termini che devono essere sempre tradotti allo stesso modo.
- **Output**: le traduzioni che scrivi, nella cartella `output/` del progetto.

## Le tre schermate

1. **Elenco dei progetti**: apri **Traduzione** nella barra laterale della Home. Qui crei, apri ed elimini progetti e scrivi il prompt di sistema globale, che vale per ogni progetto di traduzione.
2. **Dettaglio del progetto**: le lingue, il prompt del progetto (istruzioni aggiuntive solo per questo progetto), gli elenchi di documenti da tradurre, riferimenti e glossario, e la scelta per leggere le pagine scansionate (OCR). **Apri la traduzione** su un documento avvia il lavoro.
3. **Vista di traduzione**: la copia di origine a sinistra e la tua traduzione a destra, affiancate. Il riquadro dell’origine è di sola lettura. **Nascondi originale** e **Nascondi traduzione** danno tutta la finestra all’altro riquadro, che torna al punto in cui lo avevi lasciato.

## Glossario

- Aggiungi un file `.csv`, `.xlsx` o `.txt` (in `.txt` le colonne sono separate da tabulazioni). Ogni riga è un termine.
- Le colonne sono il termine di origine, la traduzione e, facoltativamente, una nota. La prima riga viene saltata solo se dà il nome alle prime due colonne (per esempio source e target, oppure term e translation); qualsiasi altra prima riga viene letta come una voce del glossario.
- I file salvati in UTF-16 (ad esempio «Testo Unicode» di Excel) vengono riconosciuti. Gli altri vengono letti come UTF-8, e come CP949 quando non sono UTF-8 valido, così i file coreani di programmi più vecchi si vedono correttamente.
- Fino a 200 voci vengono inviate per intero. Oltre 200 vengono inviate solo le voci il cui termine di origine compare nel testo da tradurre.

## File di riferimento

- Quando aggiungi un file di riferimento, l’app lo converte in testo (conservato in `references/.md/`; il file stesso non viene mai modificato) e ne indicizza le parole. Le parti vengono scelte in base alle parole del tuo messaggio e del testo selezionato (nel pannello IA, una volta all’invio) o del blocco in traduzione (nella finestra PDF), e vengono inviate solo le parti scelte, fino a 6.000 caratteri, insieme ai nomi dei file. Se tutto il testo di riferimento non supera questo limite, viene inviato per intero.
- Nel dettaglio del progetto ogni riferimento mostra il suo stato: **Convertito in testo** (aprilo con **Vedi il testo convertito**, in sola lettura), **Serve l’OCR** (una scansione o un’immagine: non ne viene inviato nulla; aggiungilo come documento da tradurre, leggilo con l’OCR e aggiungi il documento Word ottenuto come riferimento) oppure **Impossibile leggerlo**.
- Quando ne ha bisogno, l’IA può leggere un file di riferimento tramite gli strumenti del progetto.

## PDF scansionati e immagini (OCR)

- Un PDF scansionato o un’immagine non ha ancora testo da tradurre, quindi l’IA lo legge prima. Nel dettaglio del progetto scegli quale IA lo legge: **IA (Claude)**, **IA (ChatGPT)** o **Disattivato**. Se è disattivato, scansioni e immagini non possono essere aperte per la traduzione.
- Scegli le pagine da leggere, una per una o con **Seleziona tutto**. Vengono lette solo le pagine scelte.
- Le immagini delle pagine vengono inviate all’IA solo dopo la tua conferma nella schermata di controllo, che mostra quante pagine vengono inviate e quale IA viene usata. Può consumare la quota del tuo piano, e una connessione a pagamento viene indicata come a pagamento prima di inviare qualsiasi cosa.
- Il testo letto viene salvato come documento Word nella cartella di output. Traduci quel documento nella vista di traduzione con il pannello IA.
- Sono supportate le immagini PNG e JPEG. Non sono supportate le immagini GIF, BMP, TIFF e WebP, le immagini oltre 20 MB e i PDF protetti da password.

## Traduzione di PDF

- Un PDF di testo viene tradotto in un nuovo PDF nella cartella di output. Puoi anche scegliere un PDF bilingue, con la traduzione accanto a ogni pagina originale.
- La schermata di controllo mostra il numero di chiamate all’IA e quale IA viene usata prima di inviare qualsiasi cosa. La traduzione dei PDF di testo usa l’**IA da usare** dell’intera app nelle Impostazioni, mentre l’OCR usa l’IA scelta nel progetto.
- Se si interrompe, **Crea con quanto fatto** salva quanto tradotto. Quando riapri il documento, premi **Continua** per inviare solo i blocchi rimasti.

## Limiti

- Le modifiche nel riquadro dell’origine non possono essere salvate. In alcuni editor puoi digitare in memoria, ma il file in `source/` non viene scritto.
- **Traduci di nuovo** traduce tutto dall’inizio, ma mantiene i blocchi che hai modificato tu stesso nella vista bilingue dell’editor PDF.
- Arabo, ebraico e hindi non possono essere la lingua di destinazione di un PDF tradotto.
- Una finestra lasciata aperta a lungo scade; riaprila dal progetto.
