# WhatsApp AI Bot (Production-Ready Memory & Admin Layer)

Repositori ini bukan sekadar gateway WhatsApp biasa. Ini adalah **sistem backend terskala** yang menggabungkan WhatsApp Web (Baileys), **memori AI jangka panjang berbasis PostgreSQL**, dan panel administrasi terpadu.

Fitur Utama:
- **Integrasi LLM:** Meneruskan pesan ke **ai-orchestrator** (FastAPI + LangGraph) sebagai otak utamanya.
- **Durable Memory Layer (PostgreSQL):** Penyimpanan riwayat chat, ekstraksi pola implisit (cron otomatis), memori eksplisit (commands), dan integrasi pencarian semantik (pgvector).
- **Admin Panel (Web UI):** Menyediakan endpoint `/admin/*` untuk inspeksi data memori, statistik metrik, serta _hard-delete_ untuk kepatuhan GDPR (dilengkapi proteksi rate-limiting & timing attack).
- **Real-Time Contacts Sync:** Sinkronisasi kontak dinamis (`contacts.upsert`) yang tidak memblokir event loop menuju tabel `public.member_profiles`.

> **Dokumentasi detail tentang memori**: lihat [`MEMORY_DESIGN.md`](./MEMORY_DESIGN.md)
> (arsitektur memory, schema DB, fase 1a-1e+5, alur data end-to-end).
>
> **Dokumentasi migrasi briefing**: lihat [`BRIEFING_MIGRATION.md`](./BRIEFING_MIGRATION.md).

---

## ⚠️ Perlu diketahui dulu

- Baileys **tidak resmi** — WhatsApp tidak mengizinkan client pihak ketiga.
  Ada risiko nomor terkena banned/limited, terutama untuk broadcast/spam.
  Untuk penggunaan pribadi/testing wajar, risikonya kecil tapi tetap ada.
- **Jangan pakai nomor utama** untuk eksperimen — gunakan nomor cadangan.
- Untuk kebutuhan bisnis/produksi, pertimbangkan **WhatsApp Business Platform
  (Cloud API)** resmi dari Meta.

---

## Arsitektur (ringkas)

```
┌──────────────────┐  messages.upsert   ┌──────────────────────────────────────┐
│  WhatsApp (HP)   │ ─────────────────▶ │  whatsapp-bot-ai (Baileys, Node.js)  │
│  via QR pairing  │                    │  ├─ index.js       (chat handler)    │
└──────────────────┘                    │  ├─ memory/router  (select stores)   │
                                        │  ├─ memory/store   (CRUD postgres)   │
┌──────────────────┐  webhook           │  ├─ admin_routes.js(Admin Dashboard) │
│  ai-orchestrator │ ◀───────────────── │  └─ briefing.js    (cron pagi)       │
│  (FastAPI)       │                    └───────┼───────────────────┬──────────┘
│  /api/v1/chat    │                            │                   │
│  /api/v1/briefing│                            ▼                   ▼
└────────┬─────────┘                    ┌──────────────────────────┐  Admin UI
         │                              │  PostgreSQL              │ (localhost)
         │ history (10 turns)           │  ├─ whatsapp_bot.memories│
         ▼                              │  └─ public.member_profiles│
   LLM (Groq / OpenAI)                 └──────────────────────────┘
```

Bot ini **bukan LLM langsung** — ia meneruskan pesan + history ke
`ai-orchestrator` lewat HTTP, lalu menerima balasan via webhook
`/webhook/whatsapp`. Semua riwayat percakapan dan kontak tersimpan ke
PostgreSQL terpusat.

---

## Struktur project

```
services/whatsapp-bot-ai/
├── index.js                # Entry point: Baileys sock + Express webhook + cron scheduling
├── admin_routes.js         # Endpoint dashboard admin web (/admin/*) dengan rate limiting
├── briefing.js             # Modul trigger briefing pagi ke ai-orchestrator
├── package.json            # Dependensi Node.js
├── .env.example            # Template env (salin jadi .env, lihat config/env/)
├── setup_systemd.sh        # Helper install systemd service
├── README.md               # File ini
├── MEMORY_DESIGN.md        # Arsitektur memory (fase 1a-1e+5)
├── BRIEFING_MIGRATION.md   # Migrasi briefing dari WAHA → Baileys+orchestrator
├── test_*.js               # Script uji (contacts, group, models)
└── memory/
    ├── db.js                          # Connection pool (pg) + search_path=whatsapp_bot
    ├── store.js                       # CRUD memories (recent/explicit/profile/durable)
    ├── router.js                      # selectMemoryStores + command detection (!ingat, dll)
    ├── schema.sql                     # Skema fresh-install (include hardening 049 + 054)
    ├── migration_049_schema_hardening.sql  # ALTER schema existing DB
    ├── migration_052_contacts.sql     # Schema untuk member_profiles
    └── migration_054_explicit_profile.sql  # Indexes + CHECK explicit/profile
```

> `auth_info/` (folder sesi Baileys) dibuat otomatis saat pertama kali scan QR.
> **Jangan masukkan ke Git** — isinya setara akses penuh akun WhatsApp.

---

## Prasyarat

- **Node.js 18+**
- **PostgreSQL 14+** dengan database `mcp_knowledge` (schema `whatsapp_bot`
  akan dibuat otomatis oleh `memory/schema.sql`)
- **ai-orchestrator** sudah berjalan di `http://localhost:8001` (lihat
  `services/ai-orchestrator/`)
- **Nomor WhatsApp cadangan** untuk pairing (lihat peringatan di atas)

---

## Setup

### 1. Install dependencies

```bash
cd /home/aseps/MCP/services/whatsapp-bot-ai
npm install
```

### 2. Siapkan environment

Salin template dan isi variabel yang relevan. **Untuk produksi, edit
`/home/aseps/MCP/config/env/.env.core` atau `.env.messaging`** (bot membaca
`../../.env` relatif terhadap folder ini).

```bash
cp .env.example .env
# edit .env — minimal yang WAJIB diisi di sisi BOT ini:
#   WEBHOOK_SECRET         → shared secret dengan ai-orchestrator
#   POSTGRES_HOST/PORT/DB/USER/PASSWORD  → koneksi DB untuk memory layer
#   BRIEFING_GROUP_JID     → JID grup untuk briefing pagi (jika dipakai)
#
# CATATAN: OPENAI_API_KEY / GROQ_API_KEY di .env.example adalah LEGACY.
# Bot ini TIDAK memanggil LLM langsung — semua lewat FASTAPI_URL ke
# ai-orchestrator. API key LLM harus diset di .env milik ai-orchestrator
# (bukan di file ini). Lihat services/ai-orchestrator/.
```

### 3. Setup database (sekali)

```bash
PGPASSWORD="$POSTGRES_PASSWORD" psql \
  -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
  -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -f memory/schema.sql
```

Verifikasi:

```sql
\dt whatsapp_bot.*
SELECT COUNT(*) FROM whatsapp_bot.memories;
```

### 4. Jalankan bot

**Mode development:**

```bash
npm start
```

**Mode production (systemd):**

```bash
sudo ./setup_systemd.sh             # install unit file
sudo systemctl enable --now whatsapp-bot-ai.service
sudo journalctl -u whatsapp-bot-ai -f
```

### 5. Pair WhatsApp

Saat pertama kali jalan (atau setelah hapus `auth_info/`), terminal akan
menampilkan **QR code**. Scan dari HP:

> WhatsApp → Settings (⚙️) → Linked Devices → **Link a Device**

Setelah berhasil, folder `auth_info/` berisi kredensial sesi — bot tidak
perlu scan QR lagi sampai logout.

### 6. Test

Kirim pesan dari nomor lain ke nomor yang sudah pair. Pesan akan
diteruskan ke ai-orchestrator dan balasan dikirim kembali ke WhatsApp
lewat webhook.

---

## Konfigurasi (.env)

Lihat [`.env.example`](./.env.example) untuk daftar lengkap. Ringkasan
berdasarkan kelompok:

### LLM Legacy (opsional)
| Variabel | Keterangan |
|---|---|
| `OPENAI_API_KEY` | API key OpenAI (untuk prompt LLM standalone) |
| `SYSTEM_PROMPT` | Persona bot (opsional) |
| `REPLY_TO_GROUPS` | `true`/`false` — balas pesan grup juga |

### Webhook Server (Baileys → orchestrator)
| Variabel | Default | Keterangan |
|---|---|---|
| `WEBHOOK_PORT` | `3001` | Port Express webhook server |
| `WEBHOOK_HOST` | `http://localhost:3001` | URL webhook (dikirim ke orchestrator) |
| `WEBHOOK_SECRET` | — | Shared secret untuk `X-Webhook-Secret` (fallback: `MCP_WEBHOOK_SECRET`) |
| `FASTAPI_URL` | `http://localhost:8001/api/v1/chat` | Endpoint chat orchestrator |

### Briefing Pagi (cron)
| Variabel | Default | Keterangan |
|---|---|---|
| `BRIEFING_GROUP_JID` | — | JID grup target (mis. `120363426109888899@g.us`) |
| `BRIEFING_CRON` | `0 8 * * 1-5` | Senin–Jumat jam 08:00 WIB |

### Memory (Fase 1a+)
| Variabel | Default | Keterangan |
|---|---|---|
| `WHATSAPP_MEMORY_RECENT_LIMIT` | `10` | Jumlah turn history dikirim ke LLM |
| `WHATSAPP_MEMORY_RETENTION_DAYS` | `30` | Retensi `recent` memory sebelum auto-purge |
| `WHATSAPP_MEMORY_PURGE_CRON` | `0 3 * * *` | Cron purge harian (jam 03:00 WIB) |
| `WHATSAPP_MEMORY_DATABASE_URL` | (auto) | Override connection string PostgreSQL |

> `WHATSAPP_MEMORY_DATABASE_URL` jika kosong, fallback ke `DATABASE_URL`
> atau kombinasi `POSTGRES_HOST/USER/PASSWORD/DB`.

---

## Memory & Commands

Bot menyimpan memori percakapan ke PostgreSQL (schema `whatsapp_bot.memories`).
Detail lengkap di [`MEMORY_DESIGN.md`](./MEMORY_DESIGN.md). Ringkasan:

| Memory type | Trigger | Expire | Use case |
|---|---|---|---|
| `recent` | Otomatis setiap chat | 30 hari | Konteks percakapan (10 turn terakhir) |
| `explicit` | `!ingat key: value` | **Tidak** | Fakta yang user ingin disimpan persistent |
| `profile` | `!profile key value` | **Tidak** | Preferensi user (minuman, format, dll) |
| `durable` | (Fase 2 — TASK-055) | Tidak | Semantic search via pgvector + auto-merge ConsolidationJob |
| `implicit` | (Fase 3) | Tidak | Pola interaksi hasil ekstraksi otomatis |

### Commands (Fase 5 — TASK-054)

| Command | Contoh | Fungsi |
|---|---|---|
| `!ingat` | `!ingat nama_panggilan: Budi` | Simpan fakta (alias `!remember`) |
| `!lupa` | `!lupa nama_panggilan` | Hapus fakta (alias `!forget`) |
| `!profile` | `!profile minuman_favorit Kopi hitam` | Simpan preferensi |
| `!memory` | `!memory` | List semua explicit/profile memory |

Commands diproses **short-circuit** (tidak lewat LLM) dan hanya berlaku di
**personal chat** (bukan grup).

### Kontak DB-first (Fase 1e — TASK-053)

Saat Baileys menerima event `contacts.upsert`, bot **fire-and-forget**
menyimpan ke `public.member_profiles` (single source of truth untuk
RBAC + segment). `rbac.py` di orchestrator load dari DB dengan fallback
ke JSON. Lihat [MEMORY_DESIGN § 6.7](./MEMORY_DESIGN.md#67-integrasi-kontak-db-first-fase-1e--task-053).

---

## Operasi

### Restart service

```bash
sudo systemctl restart whatsapp-bot-ai.service
sudo systemctl restart mcp-ai-orchestrator.service
```

### Lihat log

```bash
sudo journalctl -u whatsapp-bot-ai -f --since "10 minutes ago"
```

### Logout (hapus sesi)

```bash
sudo systemctl stop whatsapp-bot-ai.service
rm -rf auth_info/
sudo systemctl start whatsapp-bot-ai.service
# → scan QR baru
```

### Backup auth_info

`auth_info/` berisi kredensial setara login penuh WA. **Wajib di-backup
terpisah** (jangan di-commit ke Git). Lokasi backup yang disarankan:
`storage/secrets/whatsapp-auth-<tanggal>.tar.gz` (encrypted).

### Health check cepat

```bash
# Service aktif?
systemctl is-active whatsapp-bot-ai.service

# Port webhook listening?
ss -tlnp | grep 3001

# Test endpoint webhook (simulasi balasan dari orchestrator)
curl -X POST http://localhost:3001/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d '{"user_id":"628xxx@s.whatsapp.net","response":"test"}'
```

---

## Ganti model AI

Model **tidak dipilih di bot ini** — model diatur di sisi **ai-orchestrator**
(`services/ai-orchestrator/main.py` → `get_llm()`). Lihat dokumentasi
orchestrator untuk konfigurasi Groq / OpenAI / model lain.

---

## Limitasi & Catatan

- **Baileys unofficial** — risiko banned/limited (lihat peringatan).
- **Hanya 1 instance** yang boleh berjalan per nomor — multi-instance akan
  conflict di `auth_info/`.
- **Bot grup**: hanya merespons jika ada mention / `!ai` / `@groq`. Yang
  disimpan ke memory hanya chat yang **bot respon** (Fase 1b).
- **Quota LLM**: bergantung konfigurasi orchestrator. History dibatasi 10
  turn untuk efisiensi token.
- **No encryption at-rest** untuk kolom `content` di `whatsapp_bot.memories`
  (direncanakan di Fase 6 jika perlu GDPR-grade).

---

## Roadmap singkat

| Fase | Status | Deliverable |
|---|---|---|
| 1a | ✅ | Persist `recent` memory personal + kirim history ke orchestrator |
| 1b | ✅ | Memory grup + simpan assistant response + metadata enrichment |
| 1c | ✅ | Schema hardening: dedup, CHECK, `scope_id` 128, content truncation |
| 1d | ✅ | Emoji-safe truncation + requestId round-trip + fire-and-forget |
| 1e | ✅ | DB-first contacts (`member_profiles`) + `sync_contacts` tool |
| 5  | ✅ | Commands `!ingat` / `!lupa` / `!profile` / `!memory` |
| 2  | ✅ | **Durable memory** + **ConsolidationJob** + `/api/v1/memory/extract` + `pgvector` semantic search |
| 3  | ✅ | Implicit memory (async batch via scheduler di index.js) |
| 4  | ✅ | Durable memory + semantic search (pgvector - TASK-055) |
| 6  | ✅ | Admin UI Express Web Route (`admin_routes.js`) dengan auth token |

Detail roadmap + status per fase: [MEMORY_DESIGN.md § 8](./MEMORY_DESIGN.md#8-roadmap).

---

## Referensi terkait

- [`MEMORY_DESIGN.md`](./MEMORY_DESIGN.md) — arsitektur memory lengkap
- [`BRIEFING_MIGRATION.md`](./BRIEFING_MIGRATION.md) — migrasi briefing dari WAHA
- Diagram memori: [`docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md`](../../docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md)
- Task manifest Fase 1a–5: [`tasks/01_active/TASK-04{7,8,9}-*/`](../../tasks/01_active/)
- Env config: [`docs/04-operations/07-environment-configuration.md`](../../docs/04-operations/07-environment-configuration.md)
- Orchestrator: `services/ai-orchestrator/`
- Baileys docs: https://github.com/WhiskeySockets/Baileys
