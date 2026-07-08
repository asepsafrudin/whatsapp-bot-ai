-- =============================================================================
-- TASK-052: Contacts Consolidation — Migration
-- =============================================================================
-- Lokasi: services/whatsapp-bot-ai/memory/migration_052_contacts.sql
-- Tanggal: 2026-07-08
-- Deskripsi: Migration untuk existing `public.member_profiles` table (kosong).
--            Tambah kolom segment, source, phone, email, last_synced_at.
--            Tambah index + view.
--
-- Idempotent: aman dijalankan berulang.
-- =============================================================================

-- ===== 1) Tambah kolom baru ke public.member_profiles =====
ALTER TABLE public.member_profiles
    ADD COLUMN IF NOT EXISTS segment VARCHAR(32) DEFAULT 'default';

ALTER TABLE public.member_profiles
    ADD COLUMN IF NOT EXISTS source VARCHAR(16) DEFAULT 'manual';

-- Tambah CHECK constraint untuk source (drop dulu kalau ada, lalu create)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'member_profiles_source_check'
    ) THEN
        ALTER TABLE public.member_profiles
            ADD CONSTRAINT member_profiles_source_check
            CHECK (source IN ('google', 'whatsapp', 'manual', 'merged'));
    END IF;
END$$;

ALTER TABLE public.member_profiles
    ADD COLUMN IF NOT EXISTS phone VARCHAR(32);

ALTER TABLE public.member_profiles
    ADD COLUMN IF NOT EXISTS email VARCHAR(255);

ALTER TABLE public.member_profiles
    ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ DEFAULT NOW();

-- ===== 2) Indexes =====
CREATE INDEX IF NOT EXISTS idx_member_profiles_segment
    ON public.member_profiles(segment);

CREATE INDEX IF NOT EXISTS idx_member_profiles_source
    ON public.member_profiles(source);

CREATE INDEX IF NOT EXISTS idx_member_profiles_name
    ON public.member_profiles(name);

-- ===== 3) View untuk query yang clean =====
CREATE OR REPLACE VIEW public.v_member_profiles AS
SELECT
    whatsapp_id,
    name,
    role,
    segment,
    source,
    phone,
    email,
    metadata,
    last_synced_at,
    updated_at
FROM public.member_profiles;

-- ===== 4) Update comments =====
COMMENT ON COLUMN public.member_profiles.segment        IS 'TASK-052: RBAC segment (keluarga/kantor/superadmin/perumahan/default)';
COMMENT ON COLUMN public.member_profiles.source         IS 'TASK-052: asal data (google/whatsapp/manual/merged)';
COMMENT ON COLUMN public.member_profiles.phone          IS 'TASK-052: nomor HP dari Google Contacts';
COMMENT ON COLUMN public.member_profiles.email          IS 'TASK-052: email dari Google Contacts';
COMMENT ON COLUMN public.member_profiles.last_synced_at IS 'TASK-052: timestamp terakhir kali di-sync dari Google/Baileys';

-- ===== 5) Verifikasi akhir =====
DO $$
DECLARE
    segment_exists BOOLEAN;
    source_exists BOOLEAN;
    phone_exists BOOLEAN;
    email_exists BOOLEAN;
    last_synced_exists BOOLEAN;
    segment_idx_exists BOOLEAN;
    view_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'segment'
    ) INTO segment_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'source'
    ) INTO source_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'phone'
    ) INTO phone_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'email'
    ) INTO email_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_profiles' AND column_name = 'last_synced_at'
    ) INTO last_synced_exists;

    SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'idx_member_profiles_segment'
    ) INTO segment_idx_exists;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.views
        WHERE table_schema = 'public' AND table_name = 'v_member_profiles'
    ) INTO view_exists;

    RAISE NOTICE '=== Migration 052 Verification ===';
    RAISE NOTICE 'segment column: %', segment_exists;
    RAISE NOTICE 'source column: %', source_exists;
    RAISE NOTICE 'phone column: %', phone_exists;
    RAISE NOTICE 'email column: %', email_exists;
    RAISE NOTICE 'last_synced_at column: %', last_synced_exists;
    RAISE NOTICE 'segment index: %', segment_idx_exists;
    RAISE NOTICE 'v_member_profiles view: %', view_exists;
    RAISE NOTICE '====================================';
END$$;
