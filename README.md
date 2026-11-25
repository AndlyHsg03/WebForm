# FormTanda

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env`.
2. Isi `FORMTANDA_PASSWORD` dengan password baru yang kuat dan `DATABASE_URL` dengan pooled connection string dari Neon. Jangan commit `.env`.
3. Jalankan `npm install`, lalu `npm start` dan buka `http://localhost:3000`.

Node.js 22.13 atau lebih baru diperlukan. Tabel Postgres dibuat otomatis saat API pertama kali dipanggil. Formulir, jawaban, dan tanda tangan tersimpan di Neon.

## Hosting

Import repository ini ke Vercel. Tambahkan `FORMTANDA_PASSWORD` dan `DATABASE_URL` sebagai environment variables di pengaturan proyek Vercel, lalu deploy. Untuk `DATABASE_URL`, gunakan connection string pooled Neon (host biasanya mengandung `-pooler`). Jangan masukkan rahasia tersebut ke repository. GitHub Pages hanya melayani file statis dan tidak dapat menjalankan API backend.

Semua halaman termasuk link responden meminta password yang sama. Pengunjung harus masuk sebelum membuka atau mengirim formulir. Data lama di SQLite lokal tidak otomatis dipindahkan ke Neon.