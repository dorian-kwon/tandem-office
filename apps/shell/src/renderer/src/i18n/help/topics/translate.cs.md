# Překladatelské projekty

Překladatelský projekt drží dokumenty, které chcete přeložit, vaše referenční materiály a glosář pohromadě v jedné složce a dává AI pokaždé stejné pokyny. AI vám pomáhá překládat dokumenty Word a další a textové PDF umí přeložit do nového PDF.

## Co projekt obsahuje

- **Zdroj**: dokumenty k překladu. Aplikace si ponechává vlastní kopii ve složce `source/` projektu; soubor, který jste vybrali, se nikdy neotevře ani nezmění.
- **Reference**: podpůrné materiály, například dřívější překlady nebo stylové příručky.
- **Glosář**: termíny, které se musí vždy překládat stejně.
- **Výstup**: překlady, které píšete, ve složce `output/` projektu.

## Tři obrazovky

1. **Seznam projektů**: otevřete **Překlad** v postranním panelu domovské obrazovky. Tady projekty vytváříte, otevíráte a mažete a píšete globální systémový prompt, který platí pro každý překladatelský projekt.
2. **Podrobnosti projektu**: jazyky, prompt projektu (další pokyny jen pro tento projekt), seznamy dokumentů k překladu, referencí a glosáře a volba čtení naskenovaných stránek (OCR). **Otevřít překlad** u dokumentu zahájí práci.
3. **Zobrazení překladu**: zdrojová kopie vlevo a váš překlad vpravo, vedle sebe. Zdrojový panel je jen pro čtení. **Skrýt zdroj** a **Skrýt překlad** dají celé okno druhému panelu a panel se vrátí na stejné místo.

## Glosář

- Přidejte soubor `.csv`, `.xlsx` nebo `.txt` (v `.txt` jsou sloupce odděleny tabulátory). Každý řádek je jeden termín.
- Sloupce jsou zdrojový termín, překlad a volitelně poznámka. První řádek se přeskočí jen tehdy, když pojmenovává první dva sloupce (například source a target nebo term a translation); jakýkoli jiný první řádek se čte jako položka glosáře.
- Soubory uložené v UTF-16 (například „Text v kódování Unicode“ z Excelu) se rozpoznají. Ostatní soubory se čtou jako UTF-8, a pokud nejsou platné UTF-8, jako CP949, takže korejské soubory ze starších programů se zobrazí správně.
- Až 200 položek se posílá celých. Nad 200 se posílají jen položky, jejichž zdrojový termín se vyskytuje v překládaném textu.

## Referenční soubory

- Když přidáte referenční soubor, aplikace jej převede na text (uložený v `references/.md/`; samotný soubor se nikdy nemění) a zaindexuje jeho slova. Části se vybírají podle slov vaší zprávy a vybraného textu (v panelu AI, jednou při odeslání) nebo podle slov překládané dávky (v okně PDF) a odesílají se jen vybrané části, nejvýše 6 000 znaků, spolu s názvy souborů. Pokud celý referenční text není delší, odešle se celý.
- V podrobnostech projektu ukazuje každý referenční soubor svůj stav: **Převedeno na text** (otevřete jej pomocí **Zobrazit převedený text**, jen pro čtení), **Potřebuje OCR** (sken nebo obrázek: nic se z něj neposílá; přidejte jej jako dokument k překladu, přečtěte jej pomocí OCR a výsledný dokument Word přidejte jako referenční) nebo **Nelze přečíst**.
- Když to potřebuje, může AI přečíst referenční soubor pomocí nástrojů projektu.

## Naskenovaná PDF a obrázky (OCR)

- Naskenované PDF nebo obrázek zatím nemá text k překladu, takže ho AI nejprve přečte. V podrobnostech projektu vyberte, která AI čte: **AI (Claude)**, **AI (ChatGPT)** nebo **Vypnuto**. Když je vypnuto, skeny a obrázky nelze otevřít k překladu.
- Stránky ke čtení vybíráte po jedné nebo pomocí **Vybrat vše**. Čtou se jen vybrané stránky.
- Obrázky stránek se do AI posílají až po vašem potvrzení na kontrolní obrazovce, která ukazuje, kolik stránek se pošle a která AI se použije. Může to čerpat limit vašeho tarifu a placené připojení je před odesláním označeno jako placené.
- Přečtený text se uloží jako dokument Word do výstupní složky. Tento dokument přeložte v zobrazení překladu pomocí panelu AI.
- Podporované jsou obrázky PNG a JPEG. Obrázky GIF, BMP, TIFF a WebP, obrázky nad 20 MB a PDF chráněná heslem podporovaná nejsou.

## Překlad PDF

- Textové PDF se přeloží do nového PDF ve výstupní složce. Můžete zvolit i dvojjazyčné PDF s překladem vedle každé původní stránky.
- Kontrolní obrazovka před odesláním ukazuje počet volání AI a použitou AI. Překlad textových PDF používá celoaplikační **AI k použití** z Nastavení, zatímco OCR používá AI vybranou v projektu.
- Pokud se zastaví, **Zapsat hotové** uloží, co je přeloženo. Když dokument znovu otevřete, stiskněte **Pokračovat** a pošlou se jen zbývající bloky.

## Omezení

- Úpravy ve zdrojovém panelu nelze uložit. V některých editorech lze psát v paměti, ale soubor ve `source/` se nezapisuje.
- **Přeložit znovu** přeloží vše od začátku, ale ponechá bloky, které jste sami upravili v dvojjazyčném zobrazení editoru PDF.
- Arabština, hebrejština a hindština nemohou být cílovým jazykem přeloženého PDF.
- Okno ponechané dlouho otevřené vyprší; otevřete ho znovu z projektu.
