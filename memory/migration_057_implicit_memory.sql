-- =============================================================================
-- TASK-057 (Fase 3): Migration untuk Implicit Memory
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/migration_057_implicit_memory.sql
-- Deskripsi:
--   1. Tambah index composite untuk query pola interaksi (cron job aggregate)
--      - Filter: memory_type='recent', role='user', scope_type='personal',
--        created_at >= NOW() - INTERVAL '7 days'
--      - Index untuk mempercepat aggregate query (histogram jam + word frequency)
--   2. Tidak ada kolom baru — implicit memory pakai kolom existing
--      (memory_type, role, content, source, confidence_score, metadata, expires_at)
--   3. CHECK constraint sudah ada di Fase 1a (memory_type INCLUDE 'implicit')
--   4. Tidak ada view baru (admin pakai API store.getMemoryPatterns)
--
-- Idempotent: aman dijalankan berulang kali.
--
-- Run:
--   PGPASSWORD="$POSTGRES_PASSWORD" psql \
--     -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f memory/migration_057_implicit_memory.sql
--
-- Referensi:
--   - tasks/01_active/TASK-057-implicit-memory-fase3/README.md
--   - services/whatsapp-bot-ai/MEMORY_DESIGN.md § 6.11
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Index untuk aggregate query (histogram jam & top words)
-- -----------------------------------------------------------------------------
-- Query pattern:
--   SELECT scope_id, EXTRACT(HOUR FROM created_at) AS hour, content
--   FROM whatsapp_bot.memories
--   WHERE memory_type='recent' AND role='user'
--     AND scope_type='personal' AND created_at >= NOW() - INTERVAL '7 days'
--     AND (expires_at IS NULL OR expires_at > NOW())
--   ORDER BY scope_id, created_at DESC
--
-- Index composite (scope_id, created_at DESC) — partial index WHERE memory_type='recent'
-- Karena query kita SELALU filter memory_type='recent' AND role='user', pakai partial index
-- yang lebih kecil & cepat.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot'
          AND indexname  = 'idx_memories_recent_user_personal'
    ) THEN
        CREATE INDEX idx_memories_recent_user_personal
            ON whatsapp_bot.memories (scope_id, created_at DESC)
            WHERE memory_type = 'recent'
              AND role = 'user'
              AND scope_type = 'personal';
        RAISE NOTICE '✅ Index idx_memories_recent_user_personal dibuat (composite + partial WHERE recent+user+personal).';
    ELSE
        RAISE NOTICE 'Index idx_memories_recent_user_personal sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Index untuk query getImplicitPatterns (lookup by scope, type=implicit)
-- -----------------------------------------------------------------------------
-- Query pattern:
--   SELECT * FROM whatsapp_bot.memories
--   WHERE memory_type='implicit' AND scope_id=$1 AND (expires_at IS NULL OR expires_at > NOW())
--   ORDER BY created_at DESC
--
-- Index kecil (implicit memory hanya ada jika cron jalan + scope eligible).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot'
          AND indexname  = 'idx_memories_implicit_scope'
    ) THEN
        CREATE INDEX idx_memories_implicit_scope
            ON whatsapp_bot.memories (scope_id, created_at DESC)
            WHERE memory_type = 'implicit';
        RAISE NOTICE '✅ Index idx_memories_implicit_scope dibuat (composite + partial WHERE memory_type=implicit).';
    ELSE
        RAISE NOTICE 'Index idx_memories_implicit_scope sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Index untuk purgeImplicitOlderThan (cleanup)
-- -----------------------------------------------------------------------------
-- Query pattern:
--   DELETE FROM whatsapp_bot.memories
--   WHERE memory_type='implicit' AND expires_at < NOW()
--
-- Index pada expires_at WHERE memory_type='implicit' — mempercepat purge.
-- (Index expires_at existing idx_memories_expires hanya cover memory_type='recent',
--  tidak cover 'implicit'.)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot'
          AND indexname  = 'idx_memories_implicit_expires'
    ) THEN
        CREATE INDEX idx_memories_implicit_expires
            ON whatsapp_bot.memories (expires_at)
            WHERE memory_type = 'implicit' AND expires_at IS NOT NULL;
        RAISE NOTICE '✅ Index idx_memories_implicit_expires dibuat (partial WHERE implicit+expires_at IS NOT NULL).';
    ELSE
        RAISE NOTICE 'Index idx_memories_implicit_expires sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Verifikasi hasil migration
-- -----------------------------------------------------------------------------
\echo '=== TASK-057 Migration Verification ==='
SELECT
    'idx_memories_recent_user_personal' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot' AND indexname = 'idx_memories_recent_user_personal'
    ) THEN 'OK' ELSE 'MISSING' END AS status
UNION ALL
SELECT
    'idx_memories_implicit_scope' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot' AND indexname = 'idx_memories_implicit_scope'
    ) THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'idx_memories_implicit_expires' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'whatsapp_bot' AND indexname = 'idx_memories_implicit_expires'
    ) THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'chk memory_type allows implicit' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'whatsapp_bot.memories'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%memory_type%implicit%'
    ) THEN 'OK (Fase 1a)' ELSE 'MISSING (Fase 1a required)' END;
\echo '=== End Verification ==='

-- =============================================================================
-- AKHIR SKRIP TASK-057
-- =============================================================================
