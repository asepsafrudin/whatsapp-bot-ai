# WhatsApp AI Bot (Unofficial, Baileys + OpenAI)

Bot WhatsApp yang berjalan di laptop/PC kamu sendiri, menggunakan library **Baileys**
(reverse-engineered WhatsApp Web protocol — bukan WhatsApp Business API resmi) dan
membalas pesan otomatis lewat **OpenAI API**.

## ⚠️ Perlu diketahui dulu

- Baileys **tidak resmi** — WhatsApp tidak mengizinkan client pihak ketiga. Ada risiko
  nomor kamu terkena banned/limited, terutama kalau dipakai untuk kirim pesan massal
  (broadcast/spam). Untuk pakai pribadi/testing wajar, risikonya kecil, tapi tetap ada.
- Sebaiknya jangan pakai nomor utama kamu untuk eksperimen — gunakan nomor cadangan.
- Untuk kebutuhan bisnis/produksi yang lebih aman, pertimbangkan **WhatsApp Business
  Platform (Cloud API)** resmi dari Meta.

## Struktur project

```
whatsapp-ai-bot/
├── index.js          # logic utama bot
├── package.json
├── .env.example       # salin jadi .env dan isi API key
└── .gitignore
```

## Cara menjalankan

1. **Install Node.js** (versi 18 atau lebih baru) kalau belum ada.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Siapkan file .env:**
   ```bash
   cp .env.example .env
   ```
   Lalu edit `.env` dan isi `OPENAI_API_KEY` dengan API key dari
   https://platform.openai.com/api-keys

4. **Jalankan bot:**
   ```bash
   npm start
   ```

5. **Scan QR code** yang muncul di terminal menggunakan WhatsApp di HP kamu:
   - Buka WhatsApp → Settings → Linked Devices → Link a Device
   - Arahkan kamera ke QR code di terminal

6. Setelah terhubung, kirim pesan ke nomor WhatsApp yang login tersebut dari nomor
   lain — bot akan otomatis membalas menggunakan AI.

## Konfigurasi

Di file `.env`:

| Variabel | Keterangan |
|---|---|
| `OPENAI_API_KEY` | API key OpenAI kamu |
| `SYSTEM_PROMPT` | Instruksi/persona untuk AI (opsional) |
| `REPLY_TO_GROUPS` | `true`/`false` — apakah bot membalas pesan grup juga |

## Sesi login

Baileys menyimpan sesi login di folder `auth_info/` supaya kamu tidak perlu scan QR
setiap kali restart. Jangan bagikan folder ini ke siapa pun — isinya setara dengan
akses penuh ke akun WhatsApp kamu. Kalau mau logout total, hapus folder `auth_info/`
lalu jalankan ulang untuk scan QR baru.

## Ganti model AI

Model AI diatur di `index.js` pada bagian `openai.chat.completions.create({ model: ... })`.
Default-nya `gpt-4o-mini` (murah & cepat). Bisa diganti ke model OpenAI lain sesuai
kebutuhan dan budget.

## Menambah fitur

Beberapa ide pengembangan lanjutan:
- Command khusus (misal `!reset` untuk hapus histori percakapan)
- Filter pengirim (whitelist/blacklist nomor tertentu)
- Simpan histori percakapan ke database (saat ini hanya di memori, hilang saat restart)
- Dukungan gambar/voice note (Baileys mendukung ini, perlu handling tambahan)
