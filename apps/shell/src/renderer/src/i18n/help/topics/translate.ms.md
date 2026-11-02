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
- Fail dibaca sebagai UTF-8, dan sebagai CP949 jika bukan UTF-8 yang sah, supaya fail Korea daripada program lama dipaparkan dengan betul.
- Sehingga 200 entri dihantar penuh. Melebihi 200, hanya entri yang istilah sumbernya muncul dalam teks yang diterjemah dihantar.

## Fail rujukan

- Bersama permintaan terjemahan, hanya nama fail rujukan dihantar, bukan kandungannya.
- Apabila perlu, AI boleh membaca fail rujukan melalui alat projek.

## PDF imbasan dan imej (OCR)

- PDF imbasan atau imej belum mempunyai teks untuk diterjemah, jadi AI membacanya dahulu. Dalam butiran projek, pilih AI yang membaca: **AI (Claude)**, **AI (ChatGPT)** atau **Mati**. Apabila mati, imbasan dan imej tidak boleh dibuka untuk diterjemah.
- Anda memilih halaman yang hendak dibaca, satu demi satu atau dengan **Pilih semua**. Hanya halaman yang dipilih dibaca.
- Imej halaman hanya dihantar kepada AI selepas anda mengesahkan pada skrin semakan, yang menunjukkan berapa halaman dihantar dan AI yang digunakan. Ini boleh menggunakan kuota pelan anda, dan sambungan berbayar dilabel sebagai berbayar sebelum apa-apa dihantar.
- Teks yang dibaca disimpan sebagai dokumen Word dalam folder output. Terjemah dokumen itu dalam paparan terjemahan dengan panel AI.
- Imej PNG dan JPEG disokong. Imej GIF, BMP, TIFF dan WebP, imej melebihi 20 MB serta PDF berkata laluan tidak disokong.

## Terjemahan PDF

- PDF teks diterjemah menjadi PDF baharu dalam folder output. Anda juga boleh memilih PDF dwibahasa, dengan terjemahan di sebelah setiap halaman asal.
- Skrin semakan menunjukkan bilangan panggilan AI dan AI yang digunakan sebelum apa-apa dihantar. Terjemahan PDF teks menggunakan **AI yang digunakan** seluruh aplikasi daripada Tetapan, manakala OCR menggunakan AI yang dipilih dalam projek.
- Jika berhenti, **Tulis yang telah siap** menyimpan yang telah diterjemah. Apabila anda membuka dokumen itu semula, tekan **Sambung** untuk menghantar hanya blok yang tinggal.

## Had

- Perubahan dalam anak tetingkap sumber tidak boleh disimpan. Dalam sesetengah editor anda boleh menaip dalam memori, tetapi fail dalam `source/` tidak ditulis.
- **Terjemah semula** menterjemah semuanya dari awal, tetapi mengekalkan blok yang anda sunting sendiri dalam paparan dwibahasa editor PDF.
- Bahasa Arab, Ibrani dan Hindi tidak boleh menjadi bahasa sasaran PDF terjemahan.
- Tetingkap yang dibiarkan terbuka lama akan tamat tempoh; buka semula daripada projek.
