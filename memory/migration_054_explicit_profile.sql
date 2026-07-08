-- =============================================================================
-- TASK-054 (Fase 5): Migration untuk Explicit & Profile memory
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/migration_054_explicit_profile.sql
-- Deskripsi:
--   1. Index untuk lookup explicit/profile memory by (scope, key)
--   2. CHECK constraint: explicit memory TIDAK boleh expired (NULL)
--   3. Index untuk listing by (scope, memory_type, updated_at)
--
-- Run:
--   PGPASSWORD="$POSTGRES_PASSWORD" psql \
--     -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f memory/migration_054_explicit_profile.sql
--
-- Referensi: docs/00-meta/02-agent-operational-rules.md
--             tasks/01_active/TASK-054-explicit-profile-memory/
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Index untuk lookup by key (untuk command `!ingat`, `!lupa`, `!profile`)
-- -----------------------------------------------------------------------------
-- Query pattern: WHERE scope_type = $1 AND scope_id = $2 AND memory_type = $3
--                AND metadata->>'key' = $4
-- Partial index WHERE memory_type IN ('explicit', 'profile') supaya kecil & cepat.
CREATE INDEX IF NOT EXISTS idx_memories_explicit_profile_key
    ON whatsapp_bot.memories (scope_type, scope_id, (metadata->>'key'))
    WHERE memory_type IN ('explicit', 'profile');

-- -----------------------------------------------------------------------------
-- 2. Index untuk listing by (scope, memory_type) ORDER BY updated_at DESC
-- -----------------------------------------------------------------------------
-- Query pattern: SELECT ... WHERE scope_type = $1 AND scope_id = $2
--                AND memory_type = $3 ORDER BY updated_at DESC LIMIT N
CREATE INDEX IF NOT EXISTS idx_memories_explicit_profile_listing
    ON whatsapp_bot.memories (scope_type, scope_id, memory_type, updated_at DESC)
    WHERE memory_type IN ('explicit', 'profile');

-- -----------------------------------------------------------------------------
-- 3. CHECK constraint: explicit & profile memory TIDAK boleh expired
-- -----------------------------------------------------------------------------
-- Logika: data ini durable, durable=tidak ada expires_at. Jika expires_at
-- diset, berarti data corrupt / salah insert. Tolak.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'chk_explicit_profile_no_expiry'
    ) THEN
        ALTER TABLE whatsapp_bot.memories
            ADD CONSTRAINT chk_explicit_profile_no_expiry
            CHECK (memory_type NOT IN ('explicit', 'profile') OR expires_at IS NULL);
        RAISE NOTICE 'Constraint chk_explicit_profile_no_expiry ditambahkan.';
    ELSE
        RAISE NOTICE 'Constraint chk_explicit_profile_no_expiry sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. Verifikasi hasil migration
-- -----------------------------------------------------------------------------
SELECT
    'idx_memories_explicit_profile_key' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_explicit_profile_key')
        THEN 'OK' ELSE 'MISSING' END AS status
UNION ALL
SELECT
    'idx_memories_explicit_profile_listing' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_explicit_profile_listing')
        THEN 'OK' ELSE 'MISSING' END AS status
UNION ALL
SELECT
    'chk_explicit_profile_no_expiry' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_explicit_profile_no_expiry')
        THEN 'OK' ELSE 'MISSING' END AS status;
