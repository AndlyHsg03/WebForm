# FormTanda

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env`.
2. Isi `FORMTANDA_PASSWORD` dengan password yang kuat. Jangan commit `.env`.
3. Jalankan `npm start`, lalu buka `http://localhost:3000`.

Node.js 22.13 atau lebih baru diperlukan. SQLite menyimpan formulir, jawaban, dan tanda tangan di server.

## Hosting

Deploy sebagai aplikasi Node.js pada host yang menjalankan proses server. Atur `FORMTANDA_PASSWORD` di environment variables host dan gunakan persistent storage untuk file database yang ditentukan oleh `FORMTANDA_DB_PATH`. GitHub Pages hanya melayani file statis dan tidak dapat menjalankan server atau SQLite.

Semua halaman termasuk link responden meminta password yang sama. Pengunjung harus masuk sebelum membuka atau mengirim formulir.