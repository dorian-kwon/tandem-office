import type { Lang } from '@genoffice/i18n'

/** Localise the common conversion caveats, leaving detailed engine diagnostics intact. */
const messages = {
  ko: [
    '편집 가능한 본문을 옮겼습니다. 쪽 배치, 머리말, 주석, 복잡한 개체는 달라질 수 있습니다.',
    '인쇄되는 슬라이드 내용을 옮겼습니다. 애니메이션과 발표자 노트는 제외됩니다.',
    '표시된 시트의 셀 값을 표로 옮겼습니다. 수식, 차트, 매크로는 제외됩니다.',
    '마인드맵은 주제 개요로 옮깁니다. 지도 서식, 이미지와 연결선은 제외됩니다.',
    '전자책을 읽기 순서대로 옮깁니다. 고정 배치, 대화형 콘텐츠, 탐색 기능은 달라질 수 있습니다.',
    '{pages}쪽 이미지에서 OCR로 글자를 인식했습니다. 결과를 확인해 주세요.',
    '{pages}쪽은 이미지로 저장했습니다.',
    '{pages}쪽은 셀로 변환할 수 없었습니다.',
  ],
  en: [
    'The editable body was converted. Page layout, headers, annotations and complex objects may differ.',
    'Printed slide content was converted. Animations and speaker notes are omitted.',
    'Visible sheets were converted to tables using displayed values. Formulas, charts and macros are omitted.',
    'Mind maps are converted as topic outlines. Map styling, images and graphical connections are omitted.',
    'Book content is converted in reading order. Fixed layout, interactive content and navigation may change.',
    'Local OCR recognized text in images. Please proofread the listed pages ({pages}).',
    'Pages {pages} were saved as images.',
    'Pages {pages} could not be converted to cells.',
  ],
  ja: [
    '編集可能な本文を変換しました。ページ配置、ヘッダー、注釈、複雑なオブジェクトは変わる場合があります。',
    '印刷されるスライドの内容を変換しました。アニメーションと発表者ノートは含まれません。',
    '表示中のシートのセル値を表に変換しました。数式、グラフ、マクロは含まれません。',
    'マインドマップはトピックのアウトラインに変換されます。マップの書式、画像、接続線は含まれません。',
    '電子書籍は読む順序で変換されます。固定レイアウト、対話型コンテンツ、ナビゲーションは変わることがあります。',
    '{pages} ページの画像内の文字を端末の OCR で認識しました。結果を確認してください。',
    '{pages} ページは画像として保存しました。',
    '{pages} ページはセルに変換できませんでした。',
  ],
  zh: [
    '已转换可编辑正文。页面布局、页眉、批注和复杂对象可能有所变化。',
    '已转换可打印的幻灯片内容，不包含动画和演讲者备注。',
    '已将可见工作表中的显示值转为表格，不包含公式、图表和宏。',
    '思维导图以主题大纲形式转换，不含导图样式、图片和连线。',
    '电子书按阅读顺序转换。固定版式、交互内容和导航可能会改变。',
    '已使用本地 OCR 识别第 {pages} 页图像中的文字，请校对结果。',
    '第 {pages} 页已保存为图像。',
    '第 {pages} 页无法转换成单元格。',
  ],
  'zh-TW': [
    '已轉換可編輯的本文。頁面配置、頁首、註解和複雜物件可能有所不同。',
    '已轉換可列印的投影片內容，不包含動畫和講者備忘稿。',
    '已將可見工作表的顯示值轉為表格，不包含公式、圖表和巨集。',
    '心智圖會轉為主題大綱，不含圖表樣式、圖片和連線。',
    '電子書依閱讀順序轉換。固定版面、互動內容與導覽可能會改變。',
    '已使用本機 OCR 辨識第 {pages} 頁圖片中的文字，請校對結果。',
    '第 {pages} 頁已儲存為圖片。',
    '第 {pages} 頁無法轉換為儲存格。',
  ],
  de: [
    'Der bearbeitbare Text wurde konvertiert. Seitenlayout, Kopfzeilen, Kommentare und komplexe Objekte können abweichen.',
    'Der Druckinhalt der Folien wurde übernommen. Animationen und Vortragsnotizen entfallen.',
    'Die angezeigten Werte sichtbarer Blätter wurden als Tabellen übernommen. Formeln, Diagramme und Makros entfallen.',
    'Mindmaps werden als Themengliederung übertragen. Gestaltung, Bilder und Verbindungslinien entfallen.',
    'Buchinhalte werden in Lesereihenfolge übertragen. Festes Layout, interaktive Inhalte und Navigation können sich ändern.',
    'Die lokale Texterkennung hat Text in Bildern auf den Seiten {pages} erkannt. Bitte prüfen Sie das Ergebnis.',
    'Die Seiten {pages} wurden als Bilder gespeichert.',
    'Die Seiten {pages} konnten nicht in Zellen umgewandelt werden.',
  ],
  fr: [
    'Le corps modifiable a été converti. La mise en page, les en-têtes, les annotations et les objets complexes peuvent changer.',
    'Le contenu imprimable des diapositives a été converti. Les animations et notes du présentateur sont exclues.',
    'Les valeurs affichées des feuilles visibles ont été converties en tableaux. Les formules, graphiques et macros sont exclus.',
    'Les cartes mentales sont converties en plans. Les styles, les images et les liens graphiques sont omis.',
    'Le livre est converti dans l’ordre de lecture. La mise en page fixe, les contenus interactifs et la navigation peuvent changer.',
    'La reconnaissance locale a identifié du texte dans les images des pages {pages}. Veuillez relire le résultat.',
    'Les pages {pages} ont été enregistrées sous forme d’images.',
    'Les pages {pages} n’ont pas pu être converties en cellules.',
  ],
  es: [
    'Se convirtió el contenido editable. La disposición, los encabezados, las anotaciones y los objetos complejos pueden cambiar.',
    'Se convirtió el contenido imprimible de las diapositivas. Se omiten las animaciones y las notas del orador.',
    'Los valores mostrados en las hojas visibles se convirtieron en tablas. Se omiten las fórmulas, los gráficos y las macros.',
    'Los mapas mentales se convierten en esquemas de temas. Se omiten los estilos, imágenes y conexiones gráficas.',
    'El libro se convierte en orden de lectura. La maquetación fija, el contenido interactivo y la navegación pueden cambiar.',
    'El OCR del dispositivo reconoció texto en imágenes de las páginas {pages}. Revise el resultado.',
    'Las páginas {pages} se guardaron como imágenes.',
    'Las páginas {pages} no se pudieron convertir en celdas.',
  ],
  pt: [
    'O conteúdo editável foi convertido. A disposição das páginas, os cabeçalhos, as anotações e os objetos complexos podem mudar.',
    'O conteúdo imprimível dos slides foi convertido. As animações e as notas do apresentador são omitidas.',
    'Os valores exibidos nas planilhas visíveis foram convertidos em tabelas. Fórmulas, gráficos e macros são omitidos.',
    'Os mapas mentais são convertidos em esquemas de tópicos. Estilos, imagens e conexões gráficas são omitidos.',
    'O livro é convertido na ordem de leitura. O layout fixo, o conteúdo interativo e a navegação podem mudar.',
    'O OCR do dispositivo reconheceu texto nas imagens das páginas {pages}. Confira o resultado.',
    'As páginas {pages} foram salvas como imagens.',
    'Não foi possível converter as páginas {pages} em células.',
  ],
  it: [
    'È stato convertito il corpo modificabile. Impaginazione, intestazioni, annotazioni e oggetti complessi possono cambiare.',
    'È stato convertito il contenuto stampabile delle diapositive. Animazioni e note del relatore sono escluse.',
    'I valori visualizzati nei fogli visibili sono stati convertiti in tabelle. Formule, grafici e macro sono esclusi.',
    'Le mappe mentali vengono convertite in strutture per argomenti. Stili, immagini e collegamenti grafici sono omessi.',
    'Il libro viene convertito in ordine di lettura. Impaginazione fissa, contenuti interattivi e navigazione possono cambiare.',
    'Il riconoscimento locale ha rilevato testo nelle immagini delle pagine {pages}. Verifica il risultato.',
    'Le pagine {pages} sono state salvate come immagini.',
    'Non è stato possibile convertire le pagine {pages} in celle.',
  ],
  nl: [
    'De bewerkbare inhoud is omgezet. Pagina-indeling, kopteksten, opmerkingen en complexe objecten kunnen afwijken.',
    'De afdrukbare dia-inhoud is omgezet. Animaties en sprekersnotities zijn weggelaten.',
    'De weergegeven waarden van zichtbare bladen zijn omgezet in tabellen. Formules, grafieken en macro’s zijn weggelaten.',
    'Mindmaps worden omgezet in een onderwerpenoverzicht. Opmaak, afbeeldingen en verbindingslijnen worden weggelaten.',
    'Het boek wordt in leesvolgorde omgezet. Vaste lay-out, interactieve inhoud en navigatie kunnen veranderen.',
    'De lokale tekstherkenning heeft tekst herkend in afbeeldingen op pagina’s {pages}. Controleer het resultaat.',
    'Pagina’s {pages} zijn als afbeeldingen opgeslagen.',
    'Pagina’s {pages} konden niet naar cellen worden omgezet.',
  ],
  ru: [
    'Редактируемое содержимое преобразовано. Разметка страниц, колонтитулы, примечания и сложные объекты могут измениться.',
    'Преобразовано печатное содержимое слайдов. Анимация и заметки докладчика не включены.',
    'Отображаемые значения видимых листов преобразованы в таблицы. Формулы, диаграммы и макросы не включены.',
    'Интеллект-карты преобразуются в планы тем. Оформление, изображения и графические связи опускаются.',
    'Книга преобразуется в порядке чтения. Фиксированная вёрстка, интерактивные элементы и навигация могут измениться.',
    'На устройстве распознан текст на изображениях со страниц {pages}. Проверьте результат.',
    'Страницы {pages} сохранены как изображения.',
    'Не удалось преобразовать страницы {pages} в ячейки.',
  ],
  pl: [
    'Przekonwertowano edytowalną treść. Układ stron, nagłówki, adnotacje i złożone obiekty mogą się różnić.',
    'Przeniesiono treść slajdów przeznaczoną do druku. Pominięto animacje i notatki prelegenta.',
    'Wyświetlane wartości z widocznych arkuszy przeniesiono do tabel. Pominięto formuły, wykresy i makra.',
    'Mapy myśli są konwertowane na konspekty tematów. Pomijane są style, obrazy i połączenia graficzne.',
    'Książka jest konwertowana w kolejności czytania. Stały układ, elementy interaktywne i nawigacja mogą ulec zmianie.',
    'Lokalny OCR rozpoznał tekst na obrazach na stronach {pages}. Sprawdź wynik.',
    'Strony {pages} zapisano jako obrazy.',
    'Nie udało się przekonwertować stron {pages} na komórki.',
  ],
  cs: [
    'Upravitelný obsah byl převeden. Rozvržení stránek, záhlaví, poznámky a složité objekty se mohou lišit.',
    'Byl převeden tisknutelný obsah snímků. Animace a poznámky přednášejícího byly vynechány.',
    'Zobrazené hodnoty viditelných listů byly převedeny na tabulky. Vzorce, grafy a makra byly vynechány.',
    'Myšlenkové mapy se převedou na osnovy témat. Styly, obrázky a grafické spoje se vynechají.',
    'Kniha se převádí v pořadí čtení. Pevné rozvržení, interaktivní obsah a navigace se mohou změnit.',
    'Místní OCR rozpoznalo text v obrázcích na stránkách {pages}. Zkontrolujte výsledek.',
    'Stránky {pages} byly uloženy jako obrázky.',
    'Stránky {pages} se nepodařilo převést na buňky.',
  ],
  ar: [
    'تم تحويل النص القابل للتحرير. قد يختلف تخطيط الصفحات والرؤوس والتعليقات والعناصر المعقدة.',
    'تم تحويل محتوى الشرائح القابل للطباعة باستثناء الحركات وملاحظات المتحدث.',
    'تم تحويل القيم المعروضة في الأوراق المرئية إلى جداول باستثناء الصيغ والمخططات ووحدات الماكرو.',
    'تُحوَّل الخرائط الذهنية إلى مخططات للموضوعات. لا تُنقل الأنماط والصور والوصلات الرسومية.',
    'يُحوَّل الكتاب بترتيب القراءة. قد يتغيّر التخطيط الثابت والمحتوى التفاعلي والتنقل.',
    'تعرّف الجهاز محليًا على نص في صور الصفحات {pages}. يرجى مراجعة النتيجة.',
    'تم حفظ الصفحات {pages} كصور.',
    'تعذّر تحويل الصفحات {pages} إلى خلايا.',
  ],
  he: [
    'תוכן המסמך הניתן לעריכה הומר. פריסת הדפים, הכותרות העליונות, ההערות ועצמים מורכבים עשויים להשתנות.',
    'הומר תוכן השקופיות המיועד להדפסה. הנפשות והערות דובר הושמטו.',
    'הערכים המוצגים בגיליונות הגלויים הומרו לטבלאות. נוסחאות, תרשימים ופקודות מאקרו הושמטו.',
    'מפות חשיבה מומרות לראשי פרקים. עיצוב, תמונות וקווים מקשרים מושמטים.',
    'הספר מומר לפי סדר הקריאה. הפריסה הקבועה, התוכן האינטראקטיבי והניווט עשויים להשתנות.',
    'זיהוי התווים המקומי זיהה טקסט בתמונות בעמודים {pages}. יש לבדוק את התוצאה.',
    'העמודים {pages} נשמרו כתמונות.',
    'לא ניתן היה להמיר את העמודים {pages} לתאים.',
  ],
  hi: [
    'संपादन योग्य सामग्री बदल दी गई है। पृष्ठ विन्यास, शीर्षलेख, टिप्पणियाँ और जटिल ऑब्जेक्ट बदल सकते हैं।',
    'स्लाइड की मुद्रण योग्य सामग्री बदली गई है। एनिमेशन और वक्ता के नोट शामिल नहीं हैं।',
    'दिखाई देने वाली शीट के प्रदर्शित मान तालिकाओं में बदले गए हैं। सूत्र, चार्ट और मैक्रो शामिल नहीं हैं।',
    'माइंड मैप को विषयों की रूपरेखा में बदला जाता है। शैलियाँ, चित्र और जोड़ने वाली रेखाएँ शामिल नहीं होतीं।',
    'किताब को पढ़ने के क्रम में बदला जाता है। निश्चित लेआउट, इंटरैक्टिव सामग्री और नेविगेशन बदल सकते हैं।',
    'डिवाइस के OCR ने पृष्ठ {pages} के चित्रों में पाठ पहचाना है। कृपया परिणाम जाँचें।',
    'पृष्ठ {pages} चित्रों के रूप में सहेजे गए।',
    'पृष्ठ {pages} को सेल में नहीं बदला जा सका।',
  ],
  id: [
    'Isi yang dapat diedit telah dikonversi. Tata letak halaman, kepala halaman, anotasi, dan objek kompleks dapat berubah.',
    'Isi slide yang dapat dicetak telah dikonversi. Animasi dan catatan pembicara tidak disertakan.',
    'Nilai yang ditampilkan pada lembar yang terlihat diubah menjadi tabel. Rumus, grafik, dan makro tidak disertakan.',
    'Peta pikiran dikonversi menjadi kerangka topik. Gaya, gambar, dan garis penghubung diabaikan.',
    'Buku dikonversi sesuai urutan baca. Tata letak tetap, konten interaktif, dan navigasi dapat berubah.',
    'OCR pada perangkat mengenali teks dalam gambar di halaman {pages}. Periksa hasilnya.',
    'Halaman {pages} disimpan sebagai gambar.',
    'Halaman {pages} tidak dapat dikonversi menjadi sel.',
  ],
  ms: [
    'Kandungan yang boleh disunting telah ditukar. Susun atur halaman, pengepala, anotasi dan objek kompleks mungkin berubah.',
    'Kandungan slaid yang boleh dicetak telah ditukar. Animasi dan nota penyampai tidak disertakan.',
    'Nilai yang dipaparkan pada helaian yang kelihatan telah ditukar kepada jadual. Formula, carta dan makro tidak disertakan.',
    'Peta minda ditukar kepada rangka topik. Gaya, imej dan garis penghubung tidak disertakan.',
    'Buku ditukar mengikut turutan bacaan. Susun atur tetap, kandungan interaktif dan navigasi mungkin berubah.',
    'OCR pada peranti mengenal pasti teks dalam imej pada halaman {pages}. Sila semak hasilnya.',
    'Halaman {pages} disimpan sebagai imej.',
    'Halaman {pages} tidak dapat ditukar kepada sel.',
  ],
  th: [
    'แปลงเนื้อหาที่แก้ไขได้แล้ว เค้าโครงหน้า หัวกระดาษ คำอธิบายประกอบ และวัตถุที่ซับซ้อนอาจเปลี่ยนไป',
    'แปลงเนื้อหาสไลด์ที่พิมพ์ได้แล้ว โดยไม่รวมภาพเคลื่อนไหวและบันทึกของผู้บรรยาย',
    'แปลงค่าที่แสดงในแผ่นงานที่มองเห็นเป็นตารางแล้ว โดยไม่รวมสูตร แผนภูมิ และแมโคร',
    'แผนผังความคิดจะแปลงเป็นเค้าโครงหัวข้อ โดยไม่รวมรูปแบบ รูปภาพ และเส้นเชื่อม',
    'แปลงหนังสือตามลำดับการอ่าน เค้าโครงแบบคงที่ เนื้อหาแบบโต้ตอบ และการนำทางอาจเปลี่ยนไป',
    'OCR บนอุปกรณ์รู้จำข้อความในภาพของหน้า {pages} แล้ว โปรดตรวจสอบผลลัพธ์',
    'บันทึกหน้า {pages} เป็นภาพแล้ว',
    'ไม่สามารถแปลงหน้า {pages} เป็นเซลล์ได้',
  ],
  vi: [
    'Đã chuyển đổi nội dung có thể chỉnh sửa. Bố cục trang, đầu trang, chú thích và đối tượng phức tạp có thể thay đổi.',
    'Đã chuyển đổi nội dung có thể in của các trang chiếu. Không bao gồm hiệu ứng động và ghi chú của diễn giả.',
    'Đã chuyển các giá trị hiển thị trên trang tính đang hiện thành bảng. Không bao gồm công thức, biểu đồ và macro.',
    'Sơ đồ tư duy được chuyển thành dàn ý chủ đề. Kiểu trình bày, hình ảnh và đường nối được lược bỏ.',
    'Sách được chuyển theo thứ tự đọc. Bố cục cố định, nội dung tương tác và điều hướng có thể thay đổi.',
    'OCR trên thiết bị đã nhận dạng chữ trong ảnh ở trang {pages}. Vui lòng kiểm tra lại kết quả.',
    'Các trang {pages} đã được lưu dưới dạng ảnh.',
    'Không thể chuyển các trang {pages} thành ô.',
  ],
} satisfies Record<Lang, [string, string, string, string, string, string, string, string]>

type PdfPageWarning = 'pdf_ocr_pages' | 'pdf_image_pages' | 'pages_as_images' | 'pdf_skipped_pages'

const pdfWarningIndex: Record<PdfPageWarning, 5 | 6 | 7> = {
  pdf_ocr_pages: 5,
  pdf_image_pages: 6,
  pages_as_images: 6,
  pdf_skipped_pages: 7,
}

export function pdfPageWarning(lang: Lang, code: PdfPageWarning, pages: number[]): string {
  return messages[lang][pdfWarningIndex[code]].replace('{pages}', pages.join(', '))
}

export function conversionWarning(
  lang: Lang,
  warning: { code: string; message: string; pages?: number[] },
): string {
  switch (warning.code) {
    case 'body_conversion':
      return messages[lang][0]
    case 'printed_content':
      return messages[lang][1]
    case 'worksheet_display_values':
      return messages[lang][2]
    case 'map_outline':
      return messages[lang][3]
    case 'epub_body':
      return messages[lang][4]
    case 'pdf_ocr_pages':
    case 'pdf_image_pages':
    case 'pages_as_images':
    case 'pdf_skipped_pages':
      return warning.pages?.length
        ? pdfPageWarning(lang, warning.code, warning.pages)
        : warning.message
    default:
      return warning.message
  }
}
