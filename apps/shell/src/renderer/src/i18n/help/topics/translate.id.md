# Proyek terjemahan

Proyek terjemahan menyimpan dokumen yang ingin Anda terjemahkan, materi acuan, dan glosarium bersama dalam satu folder, dan memberi AI instruksi yang sama setiap kali. AI membantu menerjemahkan dokumen Word dan dokumen lain, serta dapat menerjemahkan PDF teks menjadi PDF baru.

## Isi proyek

- **Sumber**: dokumen yang akan diterjemahkan. Aplikasi menyimpan salinannya sendiri di folder `source/` proyek; file yang Anda pilih tidak pernah dibuka atau diubah.
- **Acuan**: materi pendukung seperti terjemahan sebelumnya atau panduan gaya.
- **Glosarium**: istilah yang harus selalu diterjemahkan dengan cara yang sama.
- **Keluaran**: terjemahan yang Anda tulis, di folder `output/` proyek.

## Tiga layar

1. **Daftar proyek**: buka **Terjemahan** di bilah samping Beranda. Di sini Anda membuat, membuka, dan menghapus proyek, serta menulis prompt sistem global yang berlaku untuk setiap proyek terjemahan.
2. **Detail proyek**: bahasa, prompt proyek (instruksi tambahan khusus proyek ini), daftar dokumen yang akan diterjemahkan, acuan, dan glosarium, serta pilihan untuk membaca halaman hasil pindai (OCR). **Buka terjemahan** pada sebuah dokumen memulai pekerjaan.
3. **Tampilan terjemahan**: salinan sumber di kiri dan terjemahan Anda di kanan, berdampingan. Panel sumber hanya-baca. **Sembunyikan sumber** dan **Sembunyikan terjemahan** memberikan seluruh jendela kepada panel lainnya, dan panel itu kembali ke posisi semula.

## Glosarium

- Tambahkan file `.csv`, `.xlsx`, atau `.txt` (pada `.txt` kolom dipisahkan dengan tab). Setiap baris adalah satu istilah.
- Kolomnya adalah istilah sumber, terjemahan, dan, jika ada, catatan. Baris pertama hanya dilewati jika menamai dua kolom pertama (misalnya source dan target, atau term dan translation); baris pertama lainnya dibaca sebagai entri glosarium.
- File yang disimpan sebagai UTF-16 (misalnya "Teks Unicode" dari Excel) dikenali. File lain dibaca sebagai UTF-8, dan sebagai CP949 jika bukan UTF-8 yang valid, sehingga file Korea dari program lama tampil dengan benar.
- Hingga 200 entri dikirim utuh. Di atas 200, hanya entri yang istilah sumbernya muncul dalam teks yang diterjemahkan yang dikirim.

## File acuan

- Saat Anda menambahkan file acuan, aplikasi mengonversinya ke teks (disimpan di `references/.md/`; file itu sendiri tidak pernah diubah) dan mengindeks kata-katanya. Bagian dipilih dengan mencocokkan kata-kata pesan Anda dan teks yang dipilih (di panel AI, sekali saat mengirim) atau kumpulan teks yang diterjemahkan (di jendela PDF), dan hanya bagian terpilih yang dikirim, hingga 6.000 karakter, bersama nama file. Jika seluruh teks acuan tidak lebih panjang dari itu, semuanya dikirim.
- Di detail proyek, setiap file acuan menunjukkan statusnya: **Dikonversi ke teks** (buka dengan **Lihat teks hasil konversi**, hanya baca), **Perlu OCR** (hasil pindaian atau gambar: tidak ada yang dikirim; tambahkan sebagai dokumen yang akan diterjemahkan, baca dengan OCR, lalu tambahkan dokumen Word hasilnya sebagai acuan) atau **Tidak dapat dibaca**.
- Bila perlu, AI dapat membaca file acuan melalui alat proyek.

## PDF hasil pindai dan gambar (OCR)

- PDF hasil pindai atau gambar belum memiliki teks untuk diterjemahkan, sehingga AI membacanya lebih dulu. Di detail proyek, pilih AI yang membaca: **AI (Claude)**, **AI (ChatGPT)**, atau **Mati**. Saat mati, hasil pindai dan gambar tidak dapat dibuka untuk diterjemahkan.
- Anda memilih halaman yang akan dibaca, satu per satu atau dengan **Pilih semua**. Hanya halaman yang dipilih yang dibaca.
- Gambar halaman baru dikirim ke AI setelah Anda mengonfirmasi di layar pemeriksaan, yang menampilkan berapa halaman yang dikirim dan AI yang digunakan. Ini dapat menggunakan kuota paket Anda, dan koneksi berbayar diberi label berbayar sebelum apa pun dikirim.
- Teks yang terbaca disimpan sebagai dokumen Word di folder keluaran. Terjemahkan dokumen itu di tampilan terjemahan dengan panel AI.
- Gambar PNG dan JPEG didukung. Gambar GIF, BMP, TIFF, dan WebP, gambar di atas 20 MB, serta PDF berkata sandi tidak didukung.
- Jika dokumen atau file acuan berisi gambar (Word, PowerPoint, Excel, OpenDocument, HWPX, atau EPUB), detail proyek menampilkan jumlahnya di samping file itu. Teks di dalam gambar tersebut bukan bagian dari teks dokumen, jadi tidak diterjemahkan dan tidak dikirim. Untuk membacanya diperlukan OCR, tetapi OCR hanya membaca PDF pindaian dan file gambar, bukan gambar di dalam file lain: ekspor atau salin halaman yang bergambar sebagai gambar PNG atau JPEG atau PDF pindaian, tambahkan sebagai dokumen yang akan diterjemahkan, lalu baca dengan OCR. Gambar yang sangat kecil (di bawah 2 KB, seperti poin daftar) dan gambar dalam PDF tidak dihitung.

## Terjemahan PDF

- PDF teks diterjemahkan menjadi PDF baru di folder keluaran. Anda juga dapat memilih PDF dwibahasa, dengan terjemahan di samping setiap halaman asli.
- Layar pemeriksaan menampilkan jumlah panggilan AI dan AI yang digunakan sebelum apa pun dikirim. Terjemahan PDF teks memakai **AI yang digunakan** di seluruh aplikasi dari Pengaturan, sedangkan OCR memakai AI yang dipilih di proyek.
- Jika berhenti, **Tulis yang sudah selesai** menyimpan yang telah diterjemahkan. Saat Anda membuka dokumen lagi, tekan **Lanjutkan** untuk mengirim hanya blok yang tersisa.

## Batasan

- Perubahan di panel sumber tidak dapat disimpan. Di beberapa editor Anda dapat mengetik di memori, tetapi file di `source/` tidak ditulis.
- **Terjemahkan lagi** menerjemahkan semuanya dari awal, tetapi mempertahankan blok yang Anda edit sendiri di tampilan dwibahasa editor PDF.
- Bahasa Arab, Ibrani, dan Hindi tidak dapat menjadi bahasa tujuan PDF terjemahan.
- Jendela yang dibiarkan terbuka lama akan kedaluwarsa; buka lagi dari proyek.
