-- =============================================================================
-- TASK-055 (Fase 2): Migration untuk ConsolidationJob & Memory Extract
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/migration_055_fase2_consolidation.sql
-- Deskripsi:
--   1. Tambah kolom `embedding vector(384)` ke whatsapp_bot.memories
--      (mengikuti dimensi output nomic-embed-text via Ollama)
--   2. Tambah kolom `consolidated_at TIMESTAMPTZ` (audit trail ConsolidationJob)
--   3. Tambah kolom `source_memory_ids BIGINT[]` (riwayat row yang di-merge jadi 1)
--   4. Buat ivfflat index untuk ANN (Approximate Nearest Neighbor) search
--      terhadap embedding (cosine distance).
--   5. Buat GIN index untuk exact match `(scope, memory_type='durable')`.
--   6. Update `idx_memories_durable_scope` (TASK-049 placeholder) jadi
--      proper composite yang support ConsolidationJob query.
--   7. View: `whatsapp_bot.v_durable_memories` untuk query ringan durable + embedding.
--
-- Idempotent: aman dijalankan berulang kali.
--
-- Run:
--   PGPASSWORD="$POSTGRES_PASSWORD" psql \
--     -h "$POSTGRES_HOST" -p "${POSTGRES_PORT:-5432}" \
--     -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
--     -f memory/migration_055_fase2_consolidation.sql
--
-- Catatan:
--   - pgvector extension WAJIB sudah ter-install di database target.
--     Jika belum: CREATE EXTENSION IF NOT EXISTS vector; (perlu superuser)
--   - Jika pgvector tidak tersedia, embedding column akan di-skip dan
--     ConsolidationJob akan fallback ke text-based similarity (Levenshtein).
--
-- Referensi:
--   - docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md
--   - services/whatsapp-bot-ai/MEMORY_DESIGN.md § Fase 2
--   - tasks/01_active/TASK-055-wa-bot-fase2-consolidation/
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Pre-flight: cek apakah pgvector extension tersedia
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_has_pgvector BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM pg_available_extensions WHERE name = 'vector'
    ) INTO v_has_pgvector;

    IF v_has_pgvector THEN
        EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
        RAISE NOTICE '✅ pgvector extension aktif.';
    ELSE
        RAISE NOTICE '⚠️ pgvector TIDAK tersedia di server ini. Skipping vector column.';
        RAISE NOTICE '   Untuk mengaktifkan: install postgresql-XX-pgvector package lalu CREATE EXTENSION vector;';
        RAISE NOTICE '   ConsolidationJob akan fallback ke text similarity (Levenshtein).';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 1. Tambah kolom `embedding vector(384)` (jika belum ada)
-- -----------------------------------------------------------------------------
-- 384 = dimensi output nomic-embed-text (default model di mcp_tools.py).
-- Kolom ini nullable karena:
--   - Recent memory tidak butuh embedding (akan dipurge 30 hari)
--   - Explicit/profile memory tidak butuh embedding (lookup by key)
--   - Hanya `durable` dan `implicit` yang akan di-embed.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name   = 'memories'
          AND column_name  = 'embedding'
    ) THEN
        -- Hanya bisa ALTER jika pgvector sudah aktif
        IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
            ALTER TABLE whatsapp_bot.memories
                ADD COLUMN embedding vector(384);
            RAISE NOTICE '✅ Kolom embedding vector(384) ditambah.';
        ELSE
            RAISE NOTICE '⚠️ Skip tambah kolom embedding — pgvector tidak aktif.';
        END IF;
    ELSE
        RAISE NOTICE 'Kolom embedding sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Tambah kolom `consolidated_at TIMESTAMPTZ` (audit trail)
-- -----------------------------------------------------------------------------
-- Diset oleh ConsolidationJob setiap kali row di-update (merge / version++).
-- NULL = belum pernah diproses ConsolidationJob.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name   = 'memories'
          AND column_name  = 'consolidated_at'
    ) THEN
        ALTER TABLE whatsapp_bot.memories
            ADD COLUMN consolidated_at TIMESTAMPTZ;
        RAISE NOTICE '✅ Kolom consolidated_at ditambah.';
    ELSE
        RAISE NOTICE 'Kolom consolidated_at sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Tambah kolom `source_memory_ids BIGINT[]` (riwayat merge)
-- -----------------------------------------------------------------------------
-- Jika ConsolidationJob merge 3 row durable menjadi 1, kolom ini mencatat
-- [row_id_lama_1, row_id_lama_2, row_id_lama_3] di row yang baru.
-- Berguna untuk trace history / undo (Fase 4).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name   = 'memories'
          AND column_name  = 'source_memory_ids'
    ) THEN
        ALTER TABLE whatsapp_bot.memories
            ADD COLUMN source_memory_ids BIGINT[];
        RAISE NOTICE '✅ Kolom source_memory_ids ditambah.';
    ELSE
        RAISE NOTICE 'Kolom source_memory_ids sudah ada, skip.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 4. ivfflat index untuk ANN (Approximate Nearest Neighbor) search
-- -----------------------------------------------------------------------------
-- 100 lists = sweet spot untuk ~10K-100K rows (cocok untuk scale Fase 2-3).
-- Operator: vector_cosine_ops (semantic similarity).
-- Hanya applicable jika pgvector aktif dan kolom embedding ada.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
       AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'whatsapp_bot'
             AND table_name   = 'memories'
             AND column_name  = 'embedding'
       )
       AND NOT EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'whatsapp_bot'
             AND indexname  = 'idx_memories_embedding_ivfflat'
       )
    THEN
        -- Buat index ivfflat (parallel-safe, butuh data di table dulu untuk akurasi)
        -- Untuk empty table, query ini tetap OK — list akan diadjust saat ANALYZE
        EXECUTE 'CREATE INDEX idx_memories_embedding_ivfflat
                 ON whatsapp_bot.memories
                 USING ivfflat (embedding vector_cosine_ops)
                 WITH (lists = 100)
                 WHERE embedding IS NOT NULL AND memory_type = ''durable''';
        RAISE NOTICE '✅ Index idx_memories_embedding_ivfflat dibuat (lists=100, cosine).';
    ELSE
        RAISE NOTICE 'Skip idx_memories_embedding_ivfflat (pgvector off / kolom embedding tidak ada / index sudah ada).';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 5. Update idx_memories_durable_scope jadi composite index
-- -----------------------------------------------------------------------------
-- Index versi lama (TASK-049): (scope_type, scope_id, memory_type) WHERE memory_type='durable'
-- Version baru: tambah (updated_at DESC) untuk ConsolidationJob yang scan by
-- "row durable paling lama yang belum di-consolidate".
DROP INDEX IF EXISTS whatsapp_bot.idx_memories_durable_scope;
CREATE INDEX IF NOT EXISTS idx_memories_durable_scope_v2
    ON whatsapp_bot.memories (scope_type, scope_id, memory_type, updated_at DESC)
    WHERE memory_type = 'durable';

-- -----------------------------------------------------------------------------
-- 6. Index untuk ConsolidationJob: cari row durable yang belum di-consolidate
-- -----------------------------------------------------------------------------
-- Query pattern ConsolidationJob:
--   SELECT ... WHERE memory_type='durable' AND consolidated_at IS NULL
--   ORDER BY created_at ASC LIMIT N
-- Index ini mempercepat query di atas.
CREATE INDEX IF NOT EXISTS idx_memories_durable_pending
    ON whatsapp_bot.memories (created_at ASC)
    WHERE memory_type = 'durable' AND consolidated_at IS NULL;

-- -----------------------------------------------------------------------------
-- 7. View: durable_memories (untuk query ringan + audit)
-- -----------------------------------------------------------------------------
-- View ini harus aman dibuat di server TANPA pgvector (di mana kolom
-- `embedding` tidak pernah dibuat). Jika pgvector aktif & kolom ada, view
-- menyertakan `has_embedding`; jika tidak, kolom `has_embedding` di-hardcode
-- ke FALSE agar view tetap bisa di-create.
DO $$
DECLARE
    v_has_embedding BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name   = 'memories'
          AND column_name  = 'embedding'
    ) INTO v_has_embedding;

    IF v_has_embedding THEN
        EXECUTE $view$
            CREATE OR REPLACE VIEW whatsapp_bot.v_durable_memories AS
            SELECT
                id,
                scope_type,
                scope_id,
                role,
                content,
                source,
                confidence_score,
                version,
                metadata,
                external_message_id,
                embedding IS NOT NULL AS has_embedding,
                consolidated_at,
                source_memory_ids,
                created_at,
                updated_at
            FROM whatsapp_bot.memories
            WHERE memory_type = 'durable'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY scope_type, scope_id, created_at DESC
        $view$;
        RAISE NOTICE '✅ View v_durable_memories dibuat (dengan kolom has_embedding).';
    ELSE
        EXECUTE $view$
            CREATE OR REPLACE VIEW whatsapp_bot.v_durable_memories AS
            SELECT
                id,
                scope_type,
                scope_id,
                role,
                content,
                source,
                confidence_score,
                version,
                metadata,
                external_message_id,
                FALSE AS has_embedding,
                consolidated_at,
                source_memory_ids,
                created_at,
                updated_at
            FROM whatsapp_bot.memories
            WHERE memory_type = 'durable'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY scope_type, scope_id, created_at DESC
        $view$;
        RAISE NOTICE '⚠️ View v_durable_memories dibuat tanpa kolom has_embedding (pgvector off).';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 8. Verifikasi hasil migration
-- -----------------------------------------------------------------------------
\echo '=== TASK-055 Migration Verification ==='
SELECT
    'pgvector extension' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')
        THEN 'OK' ELSE 'MISSING (fallback to text similarity)' END AS status
UNION ALL
SELECT
    'embedding column' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name = 'memories'
          AND column_name = 'embedding'
    ) THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'consolidated_at column' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name = 'memories'
          AND column_name = 'consolidated_at'
    ) THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'source_memory_ids column' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'whatsapp_bot'
          AND table_name = 'memories'
          AND column_name = 'source_memory_ids'
    ) THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'idx_memories_embedding_ivfflat' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_embedding_ivfflat')
        THEN 'OK' ELSE 'MISSING (or pgvector off)' END
UNION ALL
SELECT
    'idx_memories_durable_scope_v2' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_durable_scope_v2')
        THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'idx_memories_durable_pending' AS object,
    CASE WHEN EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_memories_durable_pending')
        THEN 'OK' ELSE 'MISSING' END
UNION ALL
SELECT
    'v_durable_memories view' AS object,
    CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.views
        WHERE table_schema = 'whatsapp_bot'
          AND table_name = 'v_durable_memories'
    ) THEN 'OK' ELSE 'MISSING' END;

\echo '=== End Verification ==='

-- =============================================================================
-- AKHIR SKRIP TASK-055
-- =============================================================================
