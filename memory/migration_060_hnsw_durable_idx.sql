-- TASK-060 (Fase 2 Completion): Redesign idx_memories_durable_scope ke HNSW
-- Lokasi: services/whatsapp-bot-ai/memory/migration_060_hnsw_durable_idx.sql

-- KETERANGAN:
-- Menggantikan index B-Tree placeholder pada Fase 2 dengan HNSW index
-- dari pgvector untuk memungkinkan pencarian semantik (Approximate Nearest Neighbor)
-- secara cepat.

-- Pastikan extension vector ter-install
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. Hapus index lama
DROP INDEX IF EXISTS idx_memories_durable_scope;

-- 2. Buat index baru dengan HNSW 
-- Menggunakan vector_cosine_ops karena kita mengukur cosine similarity.
-- Parameter `m` dan `ef_construction` bisa di-tune, tapi default biasanya memadai.
CREATE INDEX idx_memories_durable_scope 
ON whatsapp_bot.memories USING hnsw (embedding vector_cosine_ops) 
WHERE memory_type = 'durable' AND embedding IS NOT NULL;

-- Selesai.
