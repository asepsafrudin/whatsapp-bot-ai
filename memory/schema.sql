-- =============================================================================
-- WhatsApp Bot Memory Schema (Fase 1a + 1b + 1c: Hardened)
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/schema.sql
-- Deskripsi: Schema PostgreSQL terpusat untuk menyimpan memori AI agent
--            yang melayani whatsapp-bot-ai service. Untuk FRESH INSTALL.
--            Untuk ALTER existing DB, gunakan migration_049_schema_hardening.sql.
--
-- Referensi: docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md
-- Tasks: TASK-047 (1a), TASK-048 (1b), TASK-049 (1c - schema hardening)
-- =============================================================================
-- Idempotent: aman dijalankan berulang kali.
-- =============================================================================

-- Schema terpisah agar tidak tercampur dengan data mcp_knowledge lain.
CREATE SCHEMA IF NOT EXISTS whatsapp_bot;

-- Set search_path agar query tanpa prefix schema tetap merujuk ke sini.
-- (Catatan: aplikasi harus konek dengan options=-csearch_path=whatsapp_bot,public
--  atau menggunakan qualified names "whatsapp_bot.memories".)

-- Tabel utama: memori berlapis untuk semua scope (personal + group).
-- TASK-049: kolom external_message_id ditambah, scope_id di-expand ke VARCHAR(128)
CREATE TABLE IF NOT EXISTS whatsapp_bot.memories (
    id                  BIGSERIAL PRIMARY KEY,
    scope_type          VARCHAR(16)  NOT NULL CHECK (scope_type IN ('personal', 'group')),
    scope_id            VARCHAR(128) NOT NULL,            -- JID: 628xxx@s.whatsapp.net atau xxx@g.us
    memory_type         VARCHAR(16)  NOT NULL CHECK (memory_type IN ('recent', 'profile', 'explicit', 'durable', 'implicit')),
    role                VARCHAR(16)  CHECK (role IN ('user', 'assistant', 'system')),
    content             TEXT         NOT NULL,
    source              VARCHAR(16)  NOT NULL DEFAULT 'inferred' CHECK (source IN ('explicit', 'inferred', 'external')),
    confidence_score    REAL         NOT NULL DEFAULT 1.0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
    version             INTEGER      NOT NULL DEFAULT 1,
    metadata            JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- TASK-049: kolom untuk dedup (idempotency). NULL aman (untuk pesan internal).
    external_message_id VARCHAR(128),
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ
);

-- Index utama: lookup history per scope (untuk getRecentTurns)
CREATE INDEX IF NOT EXISTS idx_memories_scope_recent
    ON whatsapp_bot.memories (scope_type, scope_id, memory_type, created_at DESC);

-- Index untuk cleanup / purge expired rows
CREATE INDEX IF NOT EXISTS idx_memories_expires
    ON whatsapp_bot.memories (expires_at)
    WHERE expires_at IS NOT NULL;

-- Index untuk ConsolidationJob (fase berikutnya): placeholder
-- TODO Fase 2: redesign index ini untuk semantic search (pgvector/hnsw atau tsvector/GIN)
-- untuk saat ini hanya berguna untuk exact-match filter memory_type='durable'.
CREATE INDEX IF NOT EXISTS idx_memories_durable_scope
    ON whatsapp_bot.memories (scope_type, scope_id, memory_type)
    WHERE memory_type = 'durable';

-- TASK-049: Unique partial index untuk dedup berdasarkan external_message_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedup
    ON whatsapp_bot.memories (scope_type, scope_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

-- Trigger: auto-set expires_at untuk recent memory (30 hari dari created_at)
CREATE OR REPLACE FUNCTION whatsapp_bot.fn_set_recent_expires()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.memory_type = 'recent' AND NEW.expires_at IS NULL THEN
        NEW.expires_at := NEW.created_at + INTERVAL '30 days';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_set_recent_expires ON whatsapp_bot.memories;
CREATE TRIGGER trg_memories_set_recent_expires
    BEFORE INSERT ON whatsapp_bot.memories
    FOR EACH ROW EXECUTE FUNCTION whatsapp_bot.fn_set_recent_expires();

-- Trigger: maintain updated_at pada UPDATE
CREATE OR REPLACE FUNCTION whatsapp_bot.fn_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memories_touch_updated_at ON whatsapp_bot.memories;
CREATE TRIGGER trg_memories_touch_updated_at
    BEFORE UPDATE ON whatsapp_bot.memories
    FOR EACH ROW EXECUTE FUNCTION whatsapp_bot.fn_touch_updated_at();

-- TASK-049: Check constraint — role wajib terisi untuk memory_type='recent'
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chk_recent_requires_role'
    ) THEN
        ALTER TABLE whatsapp_bot.memories
            ADD CONSTRAINT chk_recent_requires_role
            CHECK (memory_type <> 'recent' OR role IS NOT NULL);
    END IF;
END$$;

-- View: recent memory per scope (untuk query ringan)
CREATE OR REPLACE VIEW whatsapp_bot.v_recent_memories AS
SELECT
    id,
    scope_type,
    scope_id,
    role,
    content,
    source,
    confidence_score,
    metadata,
    created_at
FROM whatsapp_bot.memories
WHERE memory_type = 'recent'
  AND (expires_at IS NULL OR expires_at > NOW())
ORDER BY scope_type, scope_id, created_at DESC;

-- Comment untuk dokumentasi
COMMENT ON TABLE  whatsapp_bot.memories IS
    'Memori berlapis AI agent untuk whatsapp-bot-ai service. Skema generic: scope_type (personal/group), memory_type (recent/profile/explicit/durable/implicit). Lihat docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md';
COMMENT ON COLUMN whatsapp_bot.memories.scope_type         IS 'personal = 1-on-1 chat; group = WhatsApp group';
COMMENT ON COLUMN whatsapp_bot.memories.scope_id           IS 'WhatsApp JID (628xxx@s.whatsapp.net untuk personal, xxx@g.us untuk group, atau LID baru). VARCHAR(128) untuk margin aman.';
COMMENT ON COLUMN whatsapp_bot.memories.memory_type        IS 'recent: raw history 30d | profile: preferensi user | explicit: instruksi user | durable: fakta jangka panjang | implicit: pola interaksi (async)';
COMMENT ON COLUMN whatsapp_bot.memories.role               IS 'user: pesan masuk | assistant: balasan bot | system: prompt/sistem';
COMMENT ON COLUMN whatsapp_bot.memories.source             IS 'explicit: dari user langsung | inferred: dari LLM | external: dari knowledge base / orchestrator';
COMMENT ON COLUMN whatsapp_bot.memories.expires_at         IS 'Auto-set untuk recent = created_at + 30d. Bisa diset manual untuk jenis lain (misal cache TTL).';
COMMENT ON COLUMN whatsapp_bot.memories.external_message_id IS 'ID pesan asli dari WhatsApp/Baileys (msg.key.id). UNIQUE per (scope_type, scope_id) untuk dedup. NULL untuk pesan internal.';

-- =============================================================================
-- AKHIR SKRIP
-- =============================================================================
-- Cara eksekusi (fresh install):
--   PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT \
--     -U $POSTGRES_USER -d $POSTGRES_DB -f memory/schema.sql
--
-- Untuk ALTER existing DB (Fase 1a/1b → 1c):
--   PGPASSWORD=$POSTGRES_PASSWORD psql -h $POSTGRES_HOST -p $POSTGRES_PORT \
--     -U $POSTGRES_USER -d $POSTGRES_DB -f memory/migration_049_schema_hardening.sql
--
-- Verifikasi:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'whatsapp_bot';
-- =============================================================================
