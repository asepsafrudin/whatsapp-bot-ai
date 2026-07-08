-- =============================================================================
-- TASK-049: Schema Hardening — Idempotency, Constraint, Truncation
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/migration_049_schema_hardening.sql
-- Tanggal: 2026-07-08
-- Deskripsi: Migration untuk ALTER existing DB (dari schema lama/Fase 1a/1b) menjadi
--            schema yang sudah di-hardening dengan feedback user.
--
-- Perubahan:
--   1. Tambah kolom `external_message_id VARCHAR(128)` untuk dedup
--   2. Tambah unique partial index `idx_memories_dedup` pada (scope_type, scope_id, external_message_id)
--   3. Tambah check constraint `chk_recent_requires_role`: role NOT NULL untuk recent
--   4. Expand `scope_id` dari VARCHAR(64) ke VARCHAR(128) — margin aman untuk JID grup/LID
--   5. (Fase 2 nanti) Redesign `idx_memories_durable_scope` untuk semantic search
--
-- Idempotent: aman dijalankan berulang. Aman untuk tabel kosong maupun berisi.
-- =============================================================================

-- ===== 1) Tambah kolom external_message_id =====
ALTER TABLE whatsapp_bot.memories
    ADD COLUMN IF NOT EXISTS external_message_id VARCHAR(128);

COMMENT ON COLUMN whatsapp_bot.memories.external_message_id IS
    'ID pesan asli dari WhatsApp/Baileys (msg.key.id). NULL untuk pesan yang disintesis internal (misal dari orchestrator webhook). UNIQUE per (scope_type, scope_id) untuk idempotency.';

-- ===== 2) Unique partial index untuk dedup =====
-- Hanya index row yang punya external_message_id (NULL aman, banyak NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_dedup
    ON whatsapp_bot.memories (scope_type, scope_id, external_message_id)
    WHERE external_message_id IS NOT NULL;

-- ===== 3) Check constraint: role wajib untuk recent =====
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

-- ===== 4) Expand scope_id dari VARCHAR(64) ke VARCHAR(128) =====
-- PENTING: view v_recent_memories depend on scope_id, jadi harus drop dulu
-- sebelum ALTER COLUMN, lalu recreate view setelah ALTER.
DROP VIEW IF EXISTS whatsapp_bot.v_recent_memories;

-- Aman untuk tabel kosong maupun berisi (Postgres ALTER TYPE)
ALTER TABLE whatsapp_bot.memories
    ALTER COLUMN scope_id TYPE VARCHAR(128);

-- Recreate view yang sempat di-drop
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

-- Update COMMENT
COMMENT ON COLUMN whatsapp_bot.memories.scope_id IS
    'WhatsApp JID (628xxx@s.whatsapp.net untuk personal, xxx@g.us untuk group, atau format LID baru). VARCHAR(128) untuk margin aman.';

-- ===== 5) Verifikasi akhir =====
DO $$
DECLARE
    col_exists BOOLEAN;
    idx_exists BOOLEAN;
    chk_exists BOOLEAN;
    scope_id_type TEXT;
BEGIN
    -- Cek kolom
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name = 'memories'
          AND column_name = 'external_message_id'
    ) INTO col_exists;

    -- Cek index
    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot'
          AND indexname = 'idx_memories_dedup'
    ) INTO idx_exists;

    -- Cek constraint
    SELECT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_recent_requires_role'
    ) INTO chk_exists;

    -- Cek tipe scope_id
    SELECT data_type || '(' || character_maximum_length || ')'
    INTO scope_id_type
    FROM information_schema.columns
    WHERE table_schema = 'whatsapp_bot'
      AND table_name = 'memories'
      AND column_name = 'scope_id';

    RAISE NOTICE '=== Migration 049 Verification ===';
    RAISE NOTICE 'external_message_id column exists: %', col_exists;
    RAISE NOTICE 'idx_memories_dedup index exists: %', idx_exists;
    RAISE NOTICE 'chk_recent_requires_role constraint exists: %', chk_exists;
    RAISE NOTICE 'scope_id type: %', scope_id_type;
    RAISE NOTICE '=====================================';
END$$;

-- =============================================================================
-- CATATAN UNTUK FASE 2 (TODO — belum diimplementasi):
-- =============================================================================
-- idx_memories_durable_scope saat ini masih:
--   CREATE INDEX idx_memories_durable_scope
--     ON whatsapp_bot.memories (scope_type, scope_id, memory_type)
--     WHERE memory_type = 'durable';
--
-- Untuk ConsolidationJob (Fase 2), index ini perlu didesain ulang karena:
--   - memory_type di index redundan (sudah pasti 'durable' di WHERE clause)
--   - Belum mendukung semantic search (perlu embedding column atau tsvector)
--
-- Opsi redesign saat Fase 2:
--   (a) Tambah kolom `embedding vector(384)` + ivfflat/hnsw index (pgvector)
--   (b) Tambah kolom `tsv tsvector` + GIN index (full-text search)
--   (c) Hapus index ini dulu, buat ulang saat ada workload
-- =============================================================================
