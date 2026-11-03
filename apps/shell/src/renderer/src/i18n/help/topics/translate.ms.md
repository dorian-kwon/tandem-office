# Projek terjemahan

Projek terjemahan menyimpan dokumen yang anda mahu terjemah, bahan rujukan dan glosari bersama dalam satu folder, dan memberi AI arahan yang sama setiap kali. AI membantu menterjemah dokumen Word dan dokumen lain, serta boleh menterjemah PDF teks menjadi PDF baharu.

## Kandungan projek

- **Sumber**: dokumen yang hendak diterjemah. Aplikasi menyimpan salinannya sendiri dalam folder `source/` projek; fail yang anda pilih tidak pernah dibuka atau diubah.
- **Rujukan**: bahan sokongan seperti terjemahan terdahulu atau panduan gaya.
- **Glosari**: istilah yang mesti sentiasa diterjemah dengan cara yang sama.
- **Output**: terjemahan yang anda tulis, dalam folder `output/` projek.

## Tiga skrin

1. **Senarai projek**: buka **Terjemahan** pada bar sisi Laman Utama. Di sini anda mencipta, membuka dan memadam projek, serta menulis prompt sistem global yang terpakai untuk setiap projek terjemahan.
2. **Butiran projek**: bahasa, prompt projek (arahan tambahan untuk projek ini sahaja), senarai dokumen untuk diterjemah, rujukan dan glosari, serta pilihan untuk membaca halaman yang diimbas (OCR). **Buka terjemahan** pada sesuatu dokumen memulakan kerja.
3. **Paparan terjemahan**: salinan sumber di kiri dan terjemahan anda di kanan, bersebelahan. Anak tetingkap sumber adalah baca sahaja. **Sembunyikan sumber** dan **Sembunyikan terjemahan** memberikan seluruh tetingkap kepada anak tetingkap yang lain, dan anak tetingkap itu kembali ke kedudukan asalnya.

## Glosari

- Tambah fail `.csv`, `.xlsx` atau `.txt` (dalam `.txt` lajur dipisahkan dengan tab). Setiap baris ialah satu istilah.
- Lajurnya ialah istilah sumber, terjemahan dan, jika ada, nota. Baris pertama hanya dilangkau jika ia menamakan dua lajur pertama (contohnya source dan target, atau term dan translation); baris pertama yang lain dibaca sebagai entri glosari.
- Fail yang disimpan sebagai UTF-16 (contohnya "Teks Unicode" Excel) dikenali. Fail lain dibaca sebagai UTF-8, dan sebagai CP949 jika bukan UTF-8 yang sah, supaya fail Korea daripada program lama dipaparkan dengan betul.
- Sehingga 200 entri dihantar penuh. Melebihi 200, hanya entri yang istilah sumbernya muncul dalam teks yang diterjemah dihantar.

## Fail rujukan

- Apabila anda menambah fail rujukan, aplikasi menukarnya kepada teks (disimpan dalam `references/.md/`; fail itu sendiri tidak pernah diubah) dan mengindeks perkataannya. Bahagian dipilih dengan memadankan perkataan mesej anda dan teks yang dipilih (dalam panel AI, sekali semasa menghantar) atau kelompok teks yang diterjemah (dalam tetingkap PDF), dan hanya bahagian terpilih dihantar, sehingga 6,000 aksara, bersama nama fail. Jika semua teks rujukan tidak melebihi had itu, semuanya dihantar.
- Dalam butiran projek, setiap fail rujukan menunjukkan statusnya: **Ditukar kepada teks** (buka dengan **Lihat teks tukaran**, baca sahaja), **Perlu OCR** (imbasan atau imej: tiada apa-apa dihantar; tambahkan sebagai dokumen untuk diterjemah, baca dengan OCR, kemudian tambahkan dokumen Word yang terhasil sebagai rujukan) atau **Tidak dapat dibaca**.
- Apabila perlu, AI boleh membaca fail rujukan melalui alat projek.

## PDF imbasan dan imej (OCR)

- PDF imbasan atau imej belum mempunyai teks untuk diterjemah, jadi AI membacanya dahulu. Dalam butiran projek, pilih AI yang membaca: **AI (Claude)**, **AI (ChatGPT)** atau **Mati**. Apabila mati, imbasan dan imej tidak boleh dibuka untuk diterjemah.
- Anda memilih halaman yang hendak dibaca, satu demi satu atau dengan **Pilih semua**. Hanya halaman yang dipilih dibaca.
- Imej halaman hanya dihantar kepada AI selepas anda mengesahkan pada skrin semakan, yang menunjukkan berapa halaman dihantar dan AI yang digunakan. Ini boleh menggunakan kuota pelan anda, dan sambungan berbayar dilabel sebagai berbayar sebelum apa-apa dihantar.
- Teks yang dibaca disimpan sebagai dokumen Word dalam folder output. Terjemah dokumen itu dalam paparan terjemahan dengan panel AI.
- Imej PNG dan JPEG disokong. Imej GIF, BMP, TIFF dan WebP, imej melebihi 20 MB serta PDF berkata laluan tidak disokong.
- Apabila dokumen atau fail rujukan mengandungi gambar (Word, PowerPoint, Excel, OpenDocument, HWPX atau EPUB), butiran projek menunjukkan bilangannya di sebelah fail itu. Teks di dalam gambar tersebut bukan sebahagian daripada teks dokumen, jadi ia tidak diterjemah dan tidak dihantar. Untuk membacanya OCR diperlukan, tetapi OCR hanya membaca PDF imbasan dan fail imej, bukan gambar di dalam fail lain: eksport atau salin halaman yang bergambar sebagai imej PNG atau JPEG atau PDF imbasan, tambahkan sebagai dokumen untuk diterjemah, kemudian baca dengan OCR. Gambar yang sangat kecil (bawah 2 KB, seperti titik senarai) dan gambar dalam PDF tidak dikira. Hanya gambar yang diletakkan dalam kandungan dikira: latar induk dan susun atur slaid, media yang tidak digunakan dan pratonton persamaan tidak dikira. Yang langsung tidak dikesan: PDF teks, format binari lama (doc, xls, ppt, hwp) dan teks yang dilukis sebagai bentuk, WordArt atau SmartArt, jadi tiada makluman tidak bermakna fail itu tiada teks dalam gambar.

## Terjemahan PDF

- PDF teks diterjemah menjadi PDF baharu dalam folder output. Anda juga boleh memilih PDF dwibahasa, dengan terjemahan di sebelah setiap halaman asal.
- Skrin semakan menunjukkan bilangan panggilan AI dan AI yang digunakan sebelum apa-apa dihantar. Terjemahan PDF teks menggunakan **AI yang digunakan** seluruh aplikasi daripada Tetapan, manakala OCR menggunakan AI yang dipilih dalam projek.
- Jika berhenti, **Tulis yang telah siap** menyimpan yang telah diterjemah. Apabila anda membuka dokumen itu semula, tekan **Sambung** untuk menghantar hanya blok yang tinggal.

## Had

- Perubahan dalam anak tetingkap sumber tidak boleh disimpan. Dalam sesetengah editor anda boleh menaip dalam memori, tetapi fail dalam `source/` tidak ditulis.
- **Terjemah semula** menterjemah semuanya dari awal, tetapi mengekalkan blok yang anda sunting sendiri dalam paparan dwibahasa editor PDF.
- Bahasa Arab, Ibrani dan Hindi tidak boleh menjadi bahasa sasaran PDF terjemahan.
- Tetingkap yang dibiarkan terbuka lama akan tamat tempoh; buka semula daripada projek.
