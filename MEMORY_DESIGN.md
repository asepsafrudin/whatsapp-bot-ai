# Memory Design — `services/whatsapp-bot-ai/`

> **Task:** TASK-047 (1a) + TASK-048 (1b) + TASK-049 (1c) + TASK-050 (1d) + **TASK-053 (1e)**
> **Status:** 🟢 COMPLETED (Fase 1a + 1b + 1c + 1d + **1e**)
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

## 7. Limitasi Fase 1a + 1b + 1c + 1d + 1e (Sengaja Ditunda)

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
| **2** | Endpoint `/api/v1/memory/extract` di ai-orchestrator; ConsolidationJob (similarity check, merge, versioning) | ⏳ BACKLOG |
| **3** | Implicit memory (async batch cron) — pola interaksi, jam aktif, topik populer | ⏳ BACKLOG |
| **4** | Durable memory + semantic search (pgvector) + integrasi knowledge base PUU | ⏳ BACKLOG |
| **5** | Explicit memory (`!ingat ...`); Profile memory (preferensi user) | ⏳ BACKLOG |
| **6** | Admin UI / CLI untuk lihat, hapus, export memori | ⏳ BACKLOG |

## 9. Referensi

- Diagram memori: [`docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md`](../../docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md)
- Task manifest Fase 1a: [`tasks/01_active/TASK-047-wa-bot-memory-fase1a/README.md`](../../tasks/01_active/TASK-047-wa-bot-memory-fase1a/README.md)
- Task manifest Fase 1b: [`tasks/01_active/TASK-048-wa-bot-memory-fase1b/README.md`](../../tasks/01_active/TASK-048-wa-bot-memory-fase1b/README.md)
- Env config docs: [`docs/04-operations/07-environment-configuration.md`](../../docs/04-operations/07-environment-configuration.md)
- Briefing migration: [`BRIEFING_MIGRATION.md`](./BRIEFING_MIGRATION.md)
