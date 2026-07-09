# Memory Design — `services/whatsapp-bot-ai/`

> **Task:** TASK-047 (1a) + TASK-048 (1b) + TASK-049 (1c) + TASK-050 (1d) + **TASK-053 (1e)** + **TASK-054 (5)** + **TASK-055 (2)** + **TASK-056 (6)**
> **Status:** 🟢 COMPLETED (Fase 1a + 1b + 1c + 1d + 1e + **2** + **5** + **6**)
> **Referensi utama:** [`docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md`](../../docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md)

## 1. Tujuan

Membuat bot WhatsApp AI (Baileys) **kontekstual** dengan menyimpan riwayat percakapan ke PostgreSQL terpusat sehingga:

1. Riwayat tidak hilang saat bot restart (sebelumnya masih pakai `messageCache` in-memory).
2. Balasan LLM bisa merujuk pada turn-turn sebelumnya (user + assistant).
3. Schema sudah generic untuk menambah profile, explicit, durable, implicit memory di fase berikutnya **tanpa migrasi besar**.

## 2. Arsitektur Fase 1b (Aktif)

```
┌─────────────────────────────────────────────────────────────────────────┐
│  WhatsApp (Baileys)                                                     │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │ messages.upsert (user text)
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  whatsapp-bot-ai/index.js                                              │
│   ├─ memoryRouter.selectMemoryStores({...})                            │
│   │    └─ return {active, scope_type, scope_id, memory_types}          │
│   │       (Fase 1b: personal + group → recent)                          │
│   ├─ memoryStore.saveMessage(scope, id, 'user', text, opts) ──┐        │
│   │   └─ metadata: {sender_name, group_name, quoted_message_id}│       │
│   ├─ memoryStore.getRecentTurns(scope, id, limit)            │        │
│   │   └─ return [{role, content, created_at}, ...]           │        │
│   └─ axios POST /api/v1/chat { ..., history }                │        │
│                                                                     │
│  Webhook handler /webhook/whatsapp (TASK-048):                        │
│   └─ Setelah sock.sendMessage berhasil, panggil:                      │
│      memoryStore.saveAssistantResponse(scope, id, response, metadata) │
└───────────────────────────────────────────────────────────────────┼────┘
                                                                     │
                                                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL (mcp_knowledge, schema: whatsapp_bot)                     │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │ memories (id, scope_type, scope_id, memory_type, role, content,   │ │
│  │          source, confidence_score, version, metadata, created_at,│ │
│  │          updated_at, expires_at)                                  │ │
│  │   - scope_type: 'personal' | 'group'                              │ │
│  │   - role: 'user' | 'assistant' | 'system'                         │ │
│  │   - source: 'inferred' (user/LLM) | 'external' (assistant from LLM) │ │
│  │   - metadata JSONB: {sender_name, group_name, quoted_message_id,  │ │
│  │                      isFromMe, sender_cid, isGroup, ...}          │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                  │
                  │ history: [{role, content}, ...] (max 10 turns)
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  ai-orchestrator (FastAPI)                                            │
│   ├─ POST /api/v1/chat {message, history, ...}                        │
│   └─ graph.run_orchestrator(user_id, platform, message, history=...) │
│       └─ initial_messages = [history turns] + [current user message] │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Modul Memory

### `memory/db.js` — Connection Pool
- Wrapper tipis di atas `pg` (node-postgres).
- Connection string: `DATABASE_URL` → `WHATSAPP_MEMORY_DATABASE_URL` → build dari `POSTGRES_*`.
- `search_path=whatsapp_bot,public` agar query tanpa schema prefix merujuk ke sini.
- Pool max 10 koneksi, idle 30s, timeout 5s.

### `memory/store.js` — CRUD
API:
- `saveMessage(scopeType, scopeId, role, content, opts)` — simpan 1 turn (user/assistant/system).
  - `opts.quotedMessageId` (Fase 1b): masuk ke metadata.quoted_message_id.
- `saveAssistantResponse(scopeType, scopeId, content, metadata)` (**Fase 1b**) — shortcut untuk
  `saveMessage(..., 'assistant', content, {source: 'external', is_assistant: true})`.
- `getRecentTurns(scopeType, scopeId, limit=10)` — ambil N turn terakhir, urut kronologis (lama→baru).
- `getAllRecentTurns(scopeType, scopeId, limit=10)` (**Fase 1b**) — versi dengan metadata lengkap
  untuk debugging/audit.
- `purgeExpired()` — hapus row lewat `expires_at` (dijalankan cron harian).
- `countByScope(scopeType, scopeId, memoryType='recent')` — monitoring.

### `memory/router.js` — Memory Selector
- `selectMemoryStores({remoteJid, isGroup, text})`:
  - **Fase 1a**: personal chat → `[recent]`. Grup → `active: false` (skip).
  - **Fase 1b (Aktif)**: personal + group → `active: true` dengan `[recent]`.
  - **Fase 2+** (planned): tambah `explicit` (jika pesan mengandung "ingat"), `profile`, `durable` (semantic search).

## 4. Schema PostgreSQL

Lihat [`memory/schema.sql`](./memory/schema.sql). Tabel utama:

```sql
CREATE TABLE whatsapp_bot.memories (
    id              BIGSERIAL PRIMARY KEY,
    scope_type      VARCHAR(16)  NOT NULL CHECK (scope_type IN ('personal', 'group')),
    scope_id        VARCHAR(64)  NOT NULL,
    memory_type     VARCHAR(16)  NOT NULL CHECK (memory_type IN ('recent', 'profile', 'explicit', 'durable', 'implicit')),
    role            VARCHAR(16)  CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT         NOT NULL,
    source          VARCHAR(16)  NOT NULL DEFAULT 'inferred',
    confidence_score REAL        NOT NULL DEFAULT 1.0,
    version         INTEGER      NOT NULL DEFAULT 1,
    metadata        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ
);
```

**Field kunci**:
- `scope_type` / `scope_id`: pemisah personal vs grup. `scope_id` = JID (`628xxx@s.whatsapp.net` atau `xxx@g.us`).
- `memory_type`: 5 jenis (recent/profile/explicit/durable/implicit) sesuai diagram revisi.
- `role`: 'user' / 'assistant' / 'system' (untuk LLM context).
- `source`: 'explicit' (dari user), 'inferred' (user message dari LLM context), 'external' (assistant response dari LLM).
- `expires_at`: auto-set ke `created_at + 30 days` untuk `memory_type='recent'` via trigger.

**Metadata JSONB** (Fase 1b enrichment):
- `sender_name`: pushName dari Baileys (nama display user)
- `group_name`: subject grup (best-effort, di-fetch on-the-fly)
- `quoted_message_id`: stanzaId jika user reply pesan tertentu
- `sender_cid`: JID asli pengirim (untuk grup: msg.key.participant)
- `isFromMe`, `isGroup`, `pushName`, `router_reason`, `from_webhook`, `is_assistant`, dll

**Index**:
- `idx_memories_scope_recent (scope_type, scope_id, memory_type, created_at DESC)` — untuk getRecentTurns.
- `idx_memories_expires` (partial, WHERE expires_at IS NOT NULL) — untuk purge.
- `idx_memories_durable_scope` (partial, WHERE memory_type='durable') — untuk ConsolidationJob fase 2.

## 5. Alur Data End-to-End (Fase 1b)

### 5.1 Pesan masuk (personal ATAU group)

```js
// di index.js, messages.upsert handler:
const routerResult = memoryRouter.selectMemoryStores({
  remoteJid: '6287871393744@s.whatsapp.net' atau '120363426109888899@g.us',
  isGroup: false/true,
  text: 'Bot, recap meeting PUU kemarin dong',
});

// 1) Extract metadata enrichment (Fase 1b)
const quotedMessageId = msg.message.extendedTextMessage?.contextInfo?.stanzaId || null;
let enrichedGroupName = null;
if (isGroup) {
  try { enrichedGroupName = (await sock.groupMetadata(remoteJid)).subject; } catch {}
}

// 2) Simpan user message ke DB
await memoryStore.saveMessage(routerResult.scope_type, routerResult.scope_id, 'user', text, {
  memoryType: 'recent',
  metadata: {
    sender_name: msg.pushName,
    group_name: enrichedGroupName,
    sender_cid: msg.key.participant || msg.key.remoteJid,
    // ... dll
  },
  quotedMessageId,
});

// 3) Ambil history
const turns = await memoryStore.getRecentTurns(routerResult.scope_type, routerResult.scope_id, 10);
const history = turns.map(t => ({ role: t.role, content: t.content }));

// 4) Kirim ke ai-orchestrator
await axios.post(FASTAPI_URL, { ..., history });
```

### 5.2 Bot menerima balasan dari orchestrator (webhook)

```js
// di index.js, webhook handler /webhook/whatsapp:
if (sock && user_id && response) {
  await sock.sendMessage(user_id, { text: response });

  // ============ TASK-048: Simpan assistant response ke memory ============
  const isGroup = user_id.endsWith('@g.us');
  const scope_type = isGroup ? 'group' : 'personal';
  await memoryStore.saveAssistantResponse(scope_type, user_id, response, {
    from_webhook: true,
    request_received_at: new Date().toISOString(),
  });
  // =======================================================================
}
```

### 5.3 Di ai-orchestrator (graph.py)

```python
# run_orchestrator(user_id, platform, message, history=...)
initial_messages = []
for turn in (history or []):
    if turn['role'] == 'assistant':
        initial_messages.append(AIMessage(content=turn['content']))
    elif turn['role'] == 'system':
        initial_messages.append(SystemMessage(content=turn['content']))
    else:
        initial_messages.append(HumanMessage(content=turn['content']))
initial_messages.append(HumanMessage(content=message))  # pesan saat ini

initial_state = {"messages": initial_messages, ...}
# LLM akan melihat semua turn (user + assistant) + pesan baru dalam satu prompt
```

## 6. Cara Setup / Run

### 6.1 Setup Database (sekali)

```bash
cd /home/aseps/MCP/services/whatsapp-bot-ai
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

### 6.2 Install Dependency Node

```bash
cd /home/aseps/MCP/services/whatsapp-bot-ai
npm install
# atau khusus pg:
npm install pg@^8.13.1
```

### 6.3 Konfigurasi .env

Lihat [`.env.example`](./.env.example). Yang penting:
```bash
POSTGRES_HOST=localhost
POSTGRES_PORT=5433
POSTGRES_DB=mcp_knowledge
POSTGRES_USER=mcp_user
POSTGRES_PASSWORD=mcp_password_2024

WHATSAPP_MEMORY_RECENT_LIMIT=10
WHATSAPP_MEMORY_RETENTION_DAYS=30
WHATSAPP_MEMORY_PURGE_CRON=0 3 * * *
```

### 6.4 Restart Service

```bash
sudo systemctl restart whatsapp-bot-ai.service
sudo systemctl restart mcp-ai-orchestrator.service
journalctl -u whatsapp-bot-ai -f
```

## 6.5. Schema Hardening (Fase 1c)

Per 2026-07-08, schema di-hardening berdasarkan feedback user (TASK-049):

### 6.5.1. Idempotency / Dedup (TASK-049)
- **Kolom baru**: `external_message_id VARCHAR(128)` — menyimpan `msg.key.id` dari Baileys.
- **Index baru**: `idx_memories_dedup` (UNIQUE PARTIAL) pada `(scope_type, scope_id, external_message_id)` — NULL aman.
- **Store layer**: Pakai `INSERT ... ON CONFLICT (scope_type, scope_id, external_message_id) DO NOTHING` jika `externalMessageId` diisi.
- **Return value**: `deduplicated: true` jika duplikat di-skip (id=null).

```js
// Di index.js, saveMessage call:
externalMessageId: msg.key?.id || null,  // Baileys message ID
```

### 6.5.2. CHECK Constraint (TASK-049)
- `chk_recent_requires_role`: `CHECK (memory_type <> 'recent' OR role IS NOT NULL)`.
- Mencegah bug diam-diam jika `store.js` lupa set `role`.
- Error: `new row for relation "memories" violates check constraint "chk_recent_requires_role"`

### 6.5.3. scope_id VARCHAR(128) (TASK-049)
- Expand dari VARCHAR(64) ke VARCHAR(128).
- Margin aman untuk JID grup panjang atau format LID baru WhatsApp.
- **Catatan migrasi**: view `v_recent_memories` harus di-drop dulu sebelum ALTER COLUMN, lalu di-recreate.

### 6.5.4. TODO Fase 2: idx_memories_durable_scope Redesign
- Index saat ini: `(scope_type, scope_id, memory_type) WHERE memory_type = 'durable'`
- `memory_type` di index redundan (sudah pasti 'durable' di WHERE).
- Belum mendukung semantic search (perlu embedding/tsvector).
- **Fase 2 nanti**: tambah kolom `embedding vector(384)` + ivfflat/hnsw, atau `tsv tsvector` + GIN.

### 6.5.5. Content Truncation (TASK-049)
- `store.js` punya `truncateContent(content)` yang potong ke `MAX_CONTENT_LENGTH=4000` (configurable via `WHATSAPP_MEMORY_MAX_CONTENT`).
- Metadata auto-enrich: `truncated: true, original_length: N` (untuk audit).
- Mencegah boros token LLM jika user forward dokumen besar sebagai teks.

```js
// Test hasil (pure JS):
short (11 char):  output=11,  truncated=false
exactly 4000:     output=4000, truncated=false
4001 (edge):      output=4000, truncated=true, original=4001
5000 (over):      output=4000, truncated=true, original=5000
```

### 6.5.6. File SQL Baru
- `memory/migration_049_schema_hardening.sql` — untuk ALTER existing DB.
- `memory/schema.sql` di-rewrite untuk fresh install (include semua perubahan 049).

## 6.6. Hardening Lanjutan (Fase 1d)

Per 2026-07-08, berdasarkan feedback user (TASK-050), beberapa perbaikan tambahan:

### 6.6.1. Emoji-safe Truncation
- Sebelumnya: `content.substring(0, N)` memotong per UTF-16 code unit — bisa membelah surrogate pair (emoji).
- Sekarang: `Array.from(content).slice(0, N).join('')` — code-point aware.
- Test PASS: 5000 emoji (10000 UTF-16) → terpotong di 4000 code points (8000 UTF-16), tidak ada broken surrogate.
- Note: Untuk emoji ZWJ cluster kompleks (skin tone + ZWJ), perlu `Intl.Segmenter`. Saat ini cukup code-point.

### 6.6.2. Assistant Idempotency (RequestId Round-trip)
- **Bot** generate `requestId = crypto.randomUUID()` saat terima pesan user.
- Kirim ke orchestrator di payload `/api/v1/chat` sebagai field `request_id`.
- **Orchestrator** echo `request_id` di response webhook (`webhook_payload["request_id"]`).
- **Bot webhook handler** terima `request_id` dari body, panggil `saveAssistantResponse(..., externalMessageId=request_id)`.
- **Idempotency**: jika webhook retry (misal timeout), `ON CONFLICT (scope_type, scope_id, external_message_id) DO NOTHING` skip duplikat.

### 6.6.3. Audit saveMessage: Fire-and-Forget
- **Sebelum** (Fase 1c): `await memoryStore.saveMessage(...)` di `messages.upsert` handler — blocking.
- **Sekarang** (Fase 1d): fire-and-forget — `memoryStore.saveMessage(...).then().catch()`.
- Alasan: User's latency tidak boleh terganggu oleh logging I/O ke DB.
- `getRecentTurns` **tetap await** karena critical path untuk konteks LLM.

### 6.6.4. File yang Diubah (Fase 1d)
- `services/whatsapp-bot-ai/memory/store.js` — `truncateContent` code-point aware, `saveAssistantResponse` accept `externalMessageId`
- `services/whatsapp-bot-ai/index.js` — `crypto.randomUUID()`, fire-and-forget saveMessage, `request_id` di payload + webhook handler
- `services/ai-orchestrator/main.py` — `ChatRequest.request_id` field, echo di webhook payload
- `services/whatsapp-bot-ai/MEMORY_DESIGN.md` — section 6.6 (Fase 1d)

## 6.7. Integrasi Kontak DB-first (Fase 1e — TASK-053)

Per 2026-07-08, **kontak WhatsApp + Google** disatukan ke satu source of truth: `public.member_profiles` di PostgreSQL. `rbac.py` load dari DB (fallback ke JSON), dan `index.js` upsert real-time saat Baileys terima kontak.

### 6.7.1. Skema `public.member_profiles`

| Kolom | Tipe | Keterangan |
|---|---|---|
| `whatsapp_id` | TEXT PK | JID lengkap (`628xxx@s.whatsapp.net` / `xxx@lid`) |
| `name` | TEXT | Display name hasil resolve Baileys / Google |
| `role` | TEXT | Backward-compat alias untuk `segment` (nilai sama) |
| `segment` | TEXT | Segment RBAC: `superadmin` / `keluarga` / `kantor` / `default` |
| `source` | TEXT | Asal data: `google` / `whatsapp_realtime` / `manual` |
| `phone` | TEXT | Phone number extracted dari JID |
| `email` | TEXT | Email (khusus hasil Google People API) |
| `metadata` | JSONB | Raw Baileys contact / Google People record |
| `last_synced_at` | TIMESTAMPTZ | Sync terakhir dari `contacts_sync_v2.py` mingguan |
| `updated_at` | TIMESTAMPTZ | Update terakhir (apapun sumbernya) |

### 6.7.2. Tiga Sumber Data, Satu Source of Truth

```
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│  Google People API   │    │  Baileys (WA Bot)    │    │  Manual (n8n/UI)     │
│  contacts_sync_v2.py │    │  index.js upsert hook│    │  (future TASK)       │
│  (mingguan, --no-…)  │    │  (real-time event)   │    │                      │
└──────────┬───────────┘    └──────────┬───────────┘    └──────────┬───────────┘
           │ INSERT/UPSERT             │ INSERT/UPSERT             │ INSERT
           ▼                           ▼                           ▼
        ┌─────────────────────────────────────────────────────────────────┐
        │  PostgreSQL: public.member_profiles  (single source of truth)   │
        └─────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
                              │  rbac.py (LangGraph) │
                              │  hot-reload segments │
                              │  on every chat turn  │
                              └──────────────────────┘
```

### 6.7.3. Alur Real-time Hook di `index.js`

1. Baileys event `contacts.upsert` dipicu (saat bot start / kontak baru ditemukan).
2. Handler **tetap** menulis ke `wa_contacts.json` (backward compat untuk `GET /api/contacts`).
3. **Tambahan baru (Fase 1e)**: untuk setiap kontak yang punya `id` + (`name` atau `notify`), panggil `upsertContactToDb(c)` — **fire-and-forget**, tidak `await`.
4. `upsertContactToDb`:
   - Extract phone dari JID (bagian sebelum `@`, hapus non-digit).
   - Build metadata JSONB (`push_name`, `verified_name`, `img_url`, `status`, `raw`).
   - `INSERT ... ON CONFLICT (whatsapp_id) DO UPDATE`:
     - Selalu update `name`, `metadata`, `last_synced_at`, `updated_at`.
     - **Tidak menimpa** `source`/`segment` jika existing = `google` atau `manual` (priority).
     - `phone` di-COALESCE (tidak overwrite jika existing sudah ada).
   - Log `[Contacts] ✅ contact upserted (INSERT|UPDATE): <jid> → <name>`.
   - Jika error: `console.warn` saja, jangan throw (tidak boleh ganggu flow chat).

### 6.7.4. Source Priority (siapa menang saat ada konflik)

| Existing `source` | New source | Hasil |
|---|---|---|
| `google` / `manual` | `whatsapp_realtime` | **Google/manual menang** — tidak ditimpa |
| `whatsapp_realtime` (atau kosong) | `google` | **Google menang** (contacts_sync_v2.py) |
| `whatsapp_realtime` | `whatsapp_realtime` | Latest update menang (Baileys) |

Logic ini mencegah kontak Google (yang punya segment kaya) ditimpa oleh nama push_name Baileys yang kosong.

### 6.7.5. `rbac.py` Load dari DB

- `rbac.py` di-orchestrator (Python) sebelumnya hardcode load dari `rbac_contacts.json`.
- Sekarang: **load dari PostgreSQL `public.member_profiles`** lebih dulu.
- **Fallback**: jika DB tidak tersedia / error / table kosong → fallback ke JSON.
- `reload_rbac_data()` function untuk hot-reload (misal setelah manual upsert).
- **Verifikasi**: `USER_SEGMENTS count: 124` setelah load dari DB (`member_profiles` = 123 + 1 default).
- Backward compat 100%: `rbac.py` API tidak berubah, hanya sumber data.

### 6.7.6. Agent Tool `sync_contacts` (TASK-053)

- `mcp_tools.py` punya `@tool sync_contacts(use_existing_json=False)` yang trigger `contacts_sync_v2.py` on-demand (subprocess, timeout 120s).
- Hanya superadmin (RBAC) yang punya akses — di-register di `graph.py` `complex_task_node` superadmin tools list.
- Penggunaan: superadmin chat ke bot → agent panggil `sync_contacts` → sinkronisasi full Google + WA ke DB.
- Beda dengan systemd timer (mingguan): `sync_contacts` adalah **on-demand** untuk kasus urgent.

### 6.7.7. Limitasi Fase 1e (Sengaja)

- ⏳ `index.js` tidak trigger re-classify segment setelah upsert (segment tetap `default` untuk kontak baru, akan di-update saat `contacts_sync_v2.py` mingguan menemukan kecocokan di Google).
- ⏳ Tidak ada `n8n` workflow / admin UI untuk edit segment manual (direncanakan di Fase 2).
- ⏳ Tidak ada conflict resolution jika 2 bot WhatsApp mengirim kontak yang sama (race condition unlikely, last-write-wins).

### 6.7.8. File yang Diubah (Fase 1e — TASK-053)

- `services/ai-orchestrator/rbac.py` — `load_from_postgres()` + `reload_rbac_data()` (TASK-053-B)
- `services/ai-orchestrator/mcp_tools.py` — `@tool sync_contacts` (TASK-053-C)
- `services/ai-orchestrator/graph.py` — register `sync_contacts` di superadmin tools list (TASK-053-D)
- `services/whatsapp-bot-ai/index.js` — `upsertContactToDb()` + hook di `contacts.upsert` (TASK-053-E)
- `services/whatsapp-bot-ai/MEMORY_DESIGN.md` — section 6.7 (Fase 1e) (TASK-053-F)
- `services/ai-orchestrator/contacts_sync_v2.py` — schema upsert (TASK-052, sudah ada)

## 6.8. Explicit & Profile Memory (Fase 5 — TASK-054)

Per 2026-07-08, **`!ingat` / `!lupa` / `!profile` / `!memory` commands** aktif. User bisa menyimpan fakta & preferensi yang persistent (tidak expire) ke DB, dan bot akan menjawab tanpa lewat LLM.

### 6.8.1. Perbedaan dengan `recent` memory

| Aspek | `recent` | `explicit` / `profile` |
|---|---|---|
| **Expire** | Ya (30 hari, auto-purge) | **Tidak** (durable) |
| **Trigger** | Otomatis dari semua chat | Manual via command `!ingat` |
| **Use case** | Konteks percakapan | Fakta, preferensi, catatan |
| **Lookup key** | `created_at` ORDER BY DESC | `metadata->>'key'` |
| **Versioning** | Single version | Auto-increment saat update |
| **Versi Fase** | 1a-1d | 5 (TASK-054) |

### 6.8.2. Commands

| Command | Format | Fungsi | Memory Type |
|---|---|---|---|
| `!ingat` | `!ingat <key>: <value>` | Simpan fakta | `explicit` |
| `!remember` | `!remember <key>: <value>` | Alias `!ingat` (English) | `explicit` |
| `!lupa` | `!lupa <key>` | Hapus fakta | `explicit` |
| `!forget` | `!forget <key>` | Alias `!lupa` (English) | `explicit` |
| `!profile` | `!profile <key> <value>` | Simpan preferensi | `profile` |
| `!memory` | (no arg) | List semua explicit memory | — |

Contoh:
- `!ingat nama_panggilan: Budi`
- `!profile minuman_favorit Kopi hitam`
- `!lupa nama_panggilan`
- `!memory` → list 5 item

### 6.8.3. Alur (Short-Circuit Pattern)

```
User: "Bot, !ingat nama_panggilan: Budi"
        ↓
Baileys event messages.upsert
        ↓
memoryRouter.selectMemoryStores({text: "!ingat ..."})
        ↓ command = {type: 'save_explicit', memoryType: 'explicit'}
[SHORT-CIRCUIT] Jangan forward ke orchestrator.
        ↓
handleMemoryCommand(routerResult, text)
        ↓ parseKeyValue → {key: 'nama_panggilan', value: 'Budi'}
        ↓
memoryStore.saveExplicitMemory('personal', jid, key, value, {memoryType: 'explicit'})
        ↓ INSERT ON CONFLICT (key exists) DO UPDATE SET version = version + 1
        ↓
Bot reply: "✅ Tersimpan! explicit memory nama_panggilan (v1) — baru."
```

### 6.8.4. Skema & Index (TASK-054)

- Tabel `whatsapp_bot.memories` sudah punya `memory_type='explicit'` dan `'profile'` (Fase 1a CHECK constraint).
- **Key disimpan di `metadata->>'key'`** (JSONB) — bukan kolom terpisah (flexible).
- **Index baru** (TASK-054):
  - `idx_memories_explicit_profile_key` — `(scope_type, scope_id, metadata->>'key')` WHERE memory_type IN ('explicit', 'profile')
  - `idx_memories_explicit_profile_listing` — `(scope_type, scope_id, memory_type, updated_at DESC)` WHERE memory_type IN ('explicit', 'profile')
- **CHECK constraint** (TASK-054):
  - `chk_explicit_profile_no_expiry` — explicit & profile TIDAK boleh punya `expires_at` (data durable).
- Migration: `memory/migration_054_explicit_profile.sql`.

### 6.8.5. API Store (TASK-054)

```js
// Simpan (insert atau update dengan version++)
const result = await memoryStore.saveExplicitMemory(
  'personal', '628xxx@s.whatsapp.net',
  'nama_panggilan', 'Budi',
  { memoryType: 'explicit' }
);
// → { id: 123, is_insert: true, version: 1 }

// Ambil by key
const mem = await memoryStore.getExplicitMemory(
  'personal', '628xxx@s.whatsapp.net', 'nama_panggilan'
);

// List semua
const items = await memoryStore.listExplicitMemory('personal', '628xxx@s.whatsapp.net');
// → [{ key: 'nama_panggilan', content: 'Budi', version: 1, updated_at: ... }]

// Hapus
await memoryStore.deleteExplicitMemory('personal', '628xxx@s.whatsapp.net', 'nama_panggilan');
```

### 6.8.6. Limitasi Fase 5 (Sengaja)

- ⏳ Tidak ada auto-suggest: user harus manual `!ingat` (Fase 3 — implicit memory akan extract dari chat).
- ⏳ Tidak ada `!profile` listing command (cuma `!memory`). Tambah nanti jika perlu.
- ⏳ Hanya personal chat yang proses command (group chat skip). Group admin self-test bisa pakai `fromMe=true` di personal.
- ⏳ Tidak ada encryption at-rest untuk `content` (plaintext di DB). Jika perlu GDPR-grade, tambah encryption di Fase 6.

### 6.8.7. File yang Diubah (Fase 5 — TASK-054)

- `services/whatsapp-bot-ai/memory/store.js` — `saveExplicitMemory()`, `getExplicitMemory()`, `listExplicitMemory()`, `deleteExplicitMemory()`
- `services/whatsapp-bot-ai/memory/router.js` — command detection (`!ingat` / `!lupa` / `!profile` / `!memory`)
- `services/whatsapp-bot-ai/memory/migration_054_explicit_profile.sql` — indexes + CHECK constraint
- `services/whatsapp-bot-ai/index.js` — `parseKeyValue()`, `handleMemoryCommand()`, short-circuit dispatch di `messages.upsert`
- `services/whatsapp-bot-ai/MEMORY_DESIGN.md` — section 6.8 (Fase 5)

## 6.9. Durable Memory & ConsolidationJob (Fase 2 — TASK-055)

Per 2026-07-08, **Durable memory** + **ConsolidationJob** aktif. Bot bisa menyimpan fakta jangka panjang (hasil extract LLM dari chat) dan secara otomatis merge fakta yang mirip (semantik).

### 6.9.1. Perbedaan Durable vs Recent/Explicit

| Aspek | `recent` | `explicit` | `durable` (Baru) |
|---|---|---|---|
| **Expire** | Ya (30 hari) | Tidak | **Tidak** |
| **Trigger** | Otomatis chat | Manual `!ingat` | **Ekstrak LLM** dari chat |
| **Lookup** | `created_at` ORDER BY | `metadata->>'key'` | **Cosine similarity** (pgvector) |
| **Versioning** | Single | Auto-increment | Auto-increment + **merge history** (`source_memory_ids`) |
| **Embedding** | Tidak ada | Tidak ada | **WAJIB** (vector(384)) |

### 6.9.2. Skema Database (TASK-055)

Kolom baru di `whatsapp_bot.memories`:

| Kolom | Tipe | Keterangan |
|---|---|---|
| `embedding` | `vector(384)` | nomic-embed-text via Ollama. NULL OK untuk `recent`/`explicit`. WAJIB untuk `durable`. |
| `consolidated_at` | TIMESTAMPTZ | Audit trail: kapan terakhir di-process ConsolidationJob. NULL = belum pernah. |
| `source_memory_ids` | BIGINT[] | ID row asal yang sudah di-merge jadi row ini. Untuk trace history. |

Index baru:
- `idx_memories_embedding_ivfflat` — ivfflat(cosine, lists=100) WHERE memory_type='durable'
- `idx_memories_durable_scope_v2` — composite (scope_type, scope_id, memory_type, updated_at DESC) WHERE memory_type='durable'
- `idx_memories_durable_pending` — (created_at ASC) WHERE memory_type='durable' AND consolidated_at IS NULL

View baru: `whatsapp_bot.v_durable_memories` — query ringan + has_embedding flag.

### 6.9.3. Store API (TASK-055)

```js
// Simpan durable memory (WAJIB isi embedding 384-dim)
const result = await memoryStore.saveDurableMemory(
  'personal', '628xxx@s.whatsapp.net',
  'User tinggal di Bandung, Jawa Barat.',
  {
    embedding: [0.12, 0.34, ...], // 384 floats
    sourceMemoryIds: [123, 456],  // row yang di-merge (optional)
    metadata: { category: 'personal_identity', extraction_confidence: 0.85 }
  }
);
// → { id, is_insert: true, has_embedding: true, embedding_dim: 384 }

// Cari top-K mirip (cosine similarity)
const sims = await memoryStore.findSimilarDurable(
  'personal', '628xxx@s.whatsapp.net', queryEmbedding, 5, 0.7
);
// → [{ id, content, similarity, ... }]

// Merge N row jadi 1 (winner = rows[0])
const merged = await memoryStore.mergeDurableMemories([101, 102, 103], { mergeStrategy: 'append' });
// → { winner_id: 101, merged_count: 3, new_version: 2 }

// ConsolidationJob (cron harian, idempotent)
const stats = await memoryStore.runConsolidationJob({ batchSize: 50, similarityThreshold: 0.85 });
// → { scanned: 50, merged: 8, errors: 0, duration_ms: 1234 }
```

### 6.9.4. Alur End-to-End (Fase 2)

```
┌──────────────────────────────────────────────────────────────────────┐
│ WhatsApp (Baileys)                                                    │
└─────────────────┬────────────────────────────────────────────────────┘
                  │ messages.upsert (user text)
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ whatsapp-bot-ai (Node.js)                                             │
│  1. memoryRouter.selectMemoryStores                                   │
│  2. saveMessage(recent) — seperti biasa (Fase 1a)                     │
│  3. axios POST /api/v1/chat { history }                                │
│                                                                       │
│  -- TRIGGER MEMORY EXTRACT (after chat selesai / cron) --             │
│  4. axios POST /api/v1/memory/extract { scope, history }              │
└─────────────────┬───────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ai-orchestrator (FastAPI)                                             │
│  POST /api/v1/memory/extract                                          │
│   ├─ memory_extract.extract_facts_from_history(history)               │
│   │   └─ LLM (Groq llama-3.3-70b) → [{content, confidence, ...}]      │
│   ├─ For each fact:                                                   │
│   │   ├─ memory_extract.generate_embedding_for_text(content)          │
│   │   │   └─ Ollama nomic-embed-text → vector(384)                    │
│   │   └─ POST bot:3001/memory/save_durable { ... }                    │
│   └─ Return: { extracted_count, saved_count, facts }                  │
└─────────────────┬───────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ bot: POST /memory/save_durable                                        │
│   └─ memoryStore.saveDurableMemory(scope, id, content, {embedding})   │
│       └─ INSERT INTO whatsapp_bot.memories (... embedding::vector)    │
└─────────────────┬───────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL: whatsapp_bot.memories                                     │
│   - Row baru: memory_type='durable', embedding=[...],                  │
│     consolidated_at=NULL, source_memory_ids=NULL                      │
└─────────────────────────────────────────────────────────────────────┘
                  │
                  │ -- ConsolidationJob (cron 04:00 WIB) --
                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│ whatsapp-bot-ai (cron ConsolidationJob)                                │
│  1. SELECT row durable WHERE consolidated_at IS NULL                  │
│  2. For each row:                                                      │
│     a. findSimilarDurable(embedding, threshold=0.85)                   │
│     b. Jika ada >= 2 mirip → mergeDurableMemories                     │
│     c. Mark winner consolidated                                        │
│  3. Return stats: {scanned, merged, errors, duration}                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 6.9.5. Endpoint Baru

| Service | Endpoint | Method | Fungsi |
|---|---|---|---|
| whatsapp-bot-ai | `/memory/save_durable` | POST | Simpan durable memory + embedding (dipanggil orchestrator) |
| ai-orchestrator | `/api/v1/memory/extract` | POST | Extract durable facts via LLM dari history |

Auth: sama seperti endpoint lain — `X-Webhook-Secret` header.

### 6.9.6. Environment Variable Baru

```bash
# .env (bot side)
WHATSAPP_MEMORY_CONSOLIDATION_CRON=0 4 * * *      # default 04:00 WIB harian
WHATSAPP_MEMORY_CONSOLIDATION_BATCH=50             # max row per run
WHATSAPP_MEMORY_CONSOLIDATION_SIMILARITY=0.85       # cosine threshold

# .env (orchestrator side)
OLLAMA_URL=http://localhost:11434                   # Ollama server
EMBEDDING_MODEL=nomic-embed-text                    # 384-dim
GROQ_API_KEY=gsk_xxx                                # untuk extract_facts
WHATSAPP_BOT_URL=http://localhost:3001               # callback ke bot
```

### 6.9.7. Limitasi Fase 2 (Sengaja)

- ⏳ **pgvector optional** — jika extension tidak tersedia, `embedding` column di-skip dan `findSimilarDurable` fallback ke ILIKE (text-based).
- ⏳ **Merge strategy hanya 'append'** — `'longest'` dan `'replace_winner'` reserved untuk Fase 4.
- ⏳ **Soft-delete losers** — row di-merge di-soft-delete (set `expires_at = NOW()`), bukan hard-delete. Untuk audit.
- ⏳ **Tidak ada undo** — Fase 4 akan tambah `source_memory_ids` reversal.
- ⏳ **LLM extract bisa halusinasi** — min_confidence=0.6 default, naikkan ke 0.8 jika terlalu noisy.
- ⏳ **Embedding via Ollama harus running** — jika down, fallback ke hash-based pseudo-embedding (deterministic, tidak semantically meaningful tapi cukup untuk exact-match dedup).

### 6.9.8. File yang Diubah (Fase 2 — TASK-055)

- `services/whatsapp-bot-ai/memory/migration_055_fase2_consolidation.sql` (BARU) — schema: embedding, consolidated_at, source_memory_ids + 3 index + 1 view
- `services/whatsapp-bot-ai/memory/store.js` (+ 7 API functions: `saveDurableMemory`, `getDurableMemory`, `listDurableMemory`, `findSimilarDurable`, `mergeDurableMemories`, `markConsolidated`, `runConsolidationJob`)
- `services/whatsapp-bot-ai/index.js` (+ `/memory/save_durable` endpoint + `cron.schedule(0 4 * * *)` untuk ConsolidationJob)
- `services/ai-orchestrator/memory_extract.py` (BARU) — `extract_facts_from_history()` + `generate_embedding_for_text()` + fallback embedding
- `services/ai-orchestrator/main.py` (+ `ExtractRequest` Pydantic model + `POST /api/v1/memory/extract` endpoint)
- `services/ai-orchestrator/mcp_tools.py` (+ `@tool extract_durable_memory` + `@tool list_durable_memory` untuk superadmin via chat)
- `services/ai-orchestrator/graph.py` (+ import + register 2 tools di superadmin tools list + contoh di system prompt)
- `services/whatsapp-bot-ai/MEMORY_DESIGN.md` (section 6.9 + roadmap update)


## 6.10. Admin CLI & Web UI (Fase 6 — TASK-056)

Per 2026-07-09, **Admin CLI + Web UI** untuk inspeksi manual, monitoring, dan **hard-delete (GDPR)** tersedia. Memungkinkan:
- Validasi hasil auto-extract (Fase 3 nanti).
- Kepatuhan GDPR (right-to-be-forgotten).
- Audit data per user.

### 6.10.1. Dua Antarmuka: CLI & Web UI

| Aspek | CLI (`bin/admin-memory-cli.js`) | Web UI (`/admin/*`) |
|---|---|---|
| **Akses** | SSH / terminal langsung | Browser ke `http://127.0.0.1:3001/admin/?token=...` |
| **Auth** | Tidak ada (siapa saja yang bisa SSH = admin) | `ADMIN_TOKEN` (header `X-Admin-Token` atau query `?token=`) |
| **Bind** | Tidak perlu | **WAJIB 127.0.0.1** (tidak boleh 0.0.0.0) |
| **Fitur** | search / stats / delete (--confirm) | search / stats / delete (form konfirmasi) |
| **Kapan pakai** | Cron jobs, scripting, server admin | Insidental inspection, audit, demo ke stakeholder |

### 6.10.2. Tiga API Store (TASK-056) — di `memory/store.js`

```js
// 1. searchMemoriesByScope(scopeId, opts) — list memory per user
const result = await store.searchMemoriesByScope('628xxx@s.whatsapp.net', {
  scopeType: 'personal',          // 'personal' | 'group'
  memoryTypes: ['recent', 'explicit', 'durable'],  // null = semua
  includeExpired: false,         // true = ikut sertakan row expires_at <= NOW()
  limit: 100,
});
// → { count: 5, byType: { recent: 3, explicit: 1, durable: 1 }, rows: [...] }

// 2. getMemoryStats(opts) — statistik global
const stats = await store.getMemoryStats({ scopeType: null });
// → { total, byType, oldest, newest, growth: {last_1d, last_7d, last_30d}, top_scopes: [...] }

// 3. deleteMemoriesByScope(scopeId, opts) — HARD DELETE (GDPR)
const result = await store.deleteMemoriesByScope('628xxx@s.whatsapp.net', {
  scopeType: 'personal',
  memoryTypes: ['recent'],  // null = semua, atau subset
});
// → { deleted_count: 5, byType: { recent: 5 } }
// log: '[memory/store] 🗑️ GDPR delete: 5 rows from personal:628xxx@s.whatsapp.net ({"recent":5})'
```

**Perbedaan kunci dari Fase 2**:
- Fase 2 (ConsolidationJob): **SOFT delete** (`expires_at = NOW()`) — bisa di-audit.
- Fase 6 (Admin Delete): **HARD delete** (`DELETE FROM ...`) — hilang permanen, sesuai GDPR.

### 6.10.3. CLI: `bin/admin-memory-cli.js`

Sub-commands:

```bash
# Help
node bin/admin-memory-cli.js help

# Search memory satu user
node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net
node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net --memory-type explicit,durable
node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net --include-expired --limit 100

# Stats global / per scope_type
node bin/admin-memory-cli.js stats
node bin/admin-memory-cli.js stats --scope-type personal

# Hard delete (WAJIB --confirm!)
node bin/admin-memory-cli.js delete --scope-id 628xxx@s.whatsapp.net --confirm
node bin/admin-memory-cli.js delete --scope-id 628xxx@s.whatsapp.net --memory-type explicit --confirm
```

Penting: `--confirm` WAJIB untuk delete (mencegah accidental data loss via shell history / typo).

### 6.10.4. Web UI: `/admin/*`

| Route | Method | Fungsi |
|---|---|---|
| `/admin/` | GET | Dashboard (link ke search/stats/delete) |
| `/admin/search` | GET | Form search kosong |
| `/admin/search` | POST | Eksekusi search, return tabel row |
| `/admin/stats` | GET | Statistik global (cards + tabel top scopes) |
| `/admin/delete` | GET | Form konfirmasi (WAJIB ketik ulang scope_id) |
| `/admin/delete` | POST | Eksekusi hard-delete |

**Auth middleware**:
```js
// requireAdminToken(req, res, next)
// 1. Cek ADMIN_TOKEN env (atau MCP_ADMIN_TOKEN fallback)
// 2. Validasi token dari header `X-Admin-Token` ATAU query `?token=...`
// 3. Tanpa token: 401 Unauthorized
// 4. ADMIN_TOKEN tidak di-set: 503 (refuse start)
```

**UI features**:
- Server-side render HTML (no React/build step) — sederhana, cepat.
- HTML escape untuk semua user input (mencegah XSS).
- Confirmation form delete: ketik ulang `scope_id` persis sama untuk konfirmasi.
- Dashboard dengan link navigasi (search / stats / delete).

### 6.10.5. Environment Variable Baru

```bash
# .env (bot + CLI share same env)
ADMIN_TOKEN=<random-hex-32-chars>  # WAJIB untuk Web UI; CLI optional

# Generate token:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Tanpa ADMIN_TOKEN**: Web UI return 503. CLI tetap berfungsi (siapa saja yang punya akses SSH).

### 6.10.6. Keamanan (TASK-056 — keputusan desain per user, 2026-07-09)

| Aspek | Keputusan | Alasan |
|---|---|---|
| **Auth Web UI** | `ADMIN_TOKEN` static via env var | 1 admin, akses server langsung — OAuth/session overkill |
| **Bind Web UI** | `127.0.0.1` saja (bukan `0.0.0.0`) | Tidak exposed ke internet — serangan dari luar diminimalkan |
| **Delete (GDPR)** | HARD delete (`DELETE FROM ...`) | GDPR butuh penghapusan sungguhan, beda dari soft-delete Fase 2 |
| **Konfirmasi** | CLI: `--confirm` flag. Web UI: ketik ulang scope_id | Mencegah accidental data loss |
| **Scope** | Per-user (`scope_id`), bisa filter per `memory_type` | Partial delete (misal hanya `explicit`) lebih aman |

#### ⚠️ Trade-off: WEBHOOK_BIND_ADMIN_LOCALHOST = whole-server bind

Penting untuk disadari: env var `WEBHOOK_BIND_ADMIN_LOCALHOST=true` (default) mem-bind **seluruh** Express server ke `127.0.0.1`, **bukan cuma `/admin/*`**. Artinya:
- ✅ Admin UI aman (tidak exposed ke internet)
- ⚠️ Webhook endpoint (`/webhook/whatsapp`, `/memory/save_durable`, dll) juga hanya reachable dari `127.0.0.1`
- Aman untuk setup saat ini (orchestrator + bot di host yang sama)
- **Jebakan masa depan**: kalau `ai-orchestrator` dipindah ke container/server terpisah,
  webhook callback dari orchestrator ke bot akan **diam-diam berhenti berfungsi** (tidak ada
  error, hanya bot tidak menerima balasan). Bot tidak akan membalas pesan WhatsApp.

**Solusi untuk masa depan** (tidak mendesak saat ini):
- **Quick**: set `WEBHOOK_BIND_ADMIN_LOCALHOST=false` + block `/admin/*` lewat reverse proxy (Caddy/nginx).
- **Cleaner (refactor)**: dua listener terpisah di port berbeda (admin di 127.0.0.1:3001, webhook di 0.0.0.0:3002). Butuh refactor arsitektur.
- **Detection**: tambah `/healthz` endpoint + alert jika webhook tidak menerima ping dari orchestrator dalam N menit.

### 6.10.7. Test Results (TASK-056)

**CLI (di DB nyata, mcp_knowledge):**
- ✅ `search` tanpa `--scope-id` → exit 2 + pesan jelas
- ✅ `delete` tanpa `--confirm` → exit 2 + pesan jelas
- ✅ `search existing scope` → 3 row durable (alergi seafood, anak Aisyah+Raffi, kerja PUU)
- ✅ `search --memory-type recent` → 0 row (scope hanya punya durable)
- ✅ `stats` → total 40, breakdown per type, 3 top scopes

**Web UI (port 3009, ADMIN_TOKEN=test123):**
- ✅ `/admin/` tanpa token → 401 Unauthorized (522 bytes)
- ✅ `/admin/?token=test123` → 200 Dashboard (1106 bytes)
- ✅ `/admin/stats?token=test123` → 200 Stats page, menampilkan Total=65
- ✅ `/admin/delete?token=test123` → 200 Form konfirmasi (2088 bytes)

### 6.10.8. Limitasi Fase 6 (Sengaja)

- ⏳ Tidak ada export JSON/CSV di CLI (bisa ditambah nanti sebagai v1.1).
- ⏳ Tidak ada audit log siapa yang delete apa (perlu log table baru).
- ⏳ Tidak ada batch operations (hapus multiple user sekaligus).
- ⏳ Tidak ada UI untuk edit/rollback memory (read + delete saja).
- ⏳ Tidak ada bulk import (insert).

### 6.10.9. File yang Diubah (Fase 6 — TASK-056)

- `services/whatsapp-bot-ai/memory/store.js` (+ 3 API: `searchMemoriesByScope`, `getMemoryStats`, `deleteMemoriesByScope` + re-export `db.isReady`/`db.close`)
- `services/whatsapp-bot-ai/bin/admin-memory-cli.js` (BARU) — CLI dengan sub-commands search/stats/delete
- `services/whatsapp-bot-ai/admin_routes.js` (BARU) — Express router untuk `/admin/*` (search/stats/delete)
- `services/whatsapp-bot-ai/index.js` (+ `app.use('/admin', adminRouter)`)
- `services/whatsapp-bot-ai/MEMORY_DESIGN.md` — section 6.10 (Fase 6) + roadmap updated


## 7. Limitasi Fase 1a + 1b + 1c + 1d + 1e + 5 (Sengaja Ditunda)

- ❌ **Profile, Explicit, Durable, Implicit memory belum ada** — hanya `recent` yang aktif.
- ❌ **Belum ada semantic search** — pakai `tsvector` atau `pgvector` di fase 2.
- ❌ **ConsolidationJob belum ada** — fase 2.
- ❌ **Bot TIDAK merespons semua pesan grup** (hanya jika mention/!ai/@groq). Yang berubah di Fase 1b: **jika bot merespons grup, percakapan akan tersimpan ke DB**.

## 8. Roadmap

| Fase | Deliverable | Status |
|---|---|---|
| **1a** | Persist recent memory (personal chat) + kirim history ke ai-orchestrator | ✅ COMPLETED |
| **1b** | Tambah router untuk grup chat; simpan assistant response ke DB; metadata enrichment | ✅ COMPLETED |
| **1c** | Schema hardening: dedup (`external_message_id`), CHECK constraint, `scope_id`→128, content truncation | ✅ COMPLETED |
| **1d** | Emoji-safe truncation + requestId round-trip (assistant idempotency) + fire-and-forget saveMessage | ✅ COMPLETED |
| **1e** | DB-first contacts: `public.member_profiles` sebagai SoT, `rbac.py` load dari DB, `index.js` real-time upsert, agent tool `sync_contacts` | ✅ COMPLETED (TASK-053) |
| **5** | Explicit memory (`!ingat key: value` / `!lupa` / `!profile` / `!memory`) + durable storage + indexes | ✅ COMPLETED (TASK-054) |
| **2** | Endpoint `/api/v1/memory/extract` di ai-orchestrator; ConsolidationJob (similarity check, merge, versioning) | ✅ COMPLETED (TASK-055) |
| **3** | Implicit memory (async batch cron) — pola interaksi, jam aktif, topik populer | ⏳ BACKLOG |
| **4** | Durable memory + semantic search (pgvector) + integrasi knowledge base PUU | ⏳ BACKLOG |
| **5** | Explicit memory (`!ingat ...`); Profile memory (preferensi user) | ⏳ BACKLOG |
| **6** | Admin UI / CLI untuk lihat, hapus, export memori | ✅ COMPLETED (TASK-056) |

## 9. Referensi

- Diagram memori: [`docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md`](../../docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md)
- Task manifest Fase 1a: [`tasks/01_active/TASK-047-wa-bot-memory-fase1a/README.md`](../../tasks/01_active/TASK-047-wa-bot-memory-fase1a/README.md)
- Task manifest Fase 1b: [`tasks/01_active/TASK-048-wa-bot-memory-fase1b/README.md`](../../tasks/01_active/TASK-048-wa-bot-memory-fase1b/README.md)
- Env config docs: [`docs/04-operations/07-environment-configuration.md`](../../docs/04-operations/07-environment-configuration.md)
- Briefing migration: [`BRIEFING_MIGRATION.md`](./BRIEFING_MIGRATION.md)
