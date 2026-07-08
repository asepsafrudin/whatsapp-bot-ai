// ==============================================================================
// memory/store.js — Recent Conversation Memory CRUD (Fase 1d hardened + Fase 2)
// ==============================================================================
// Lokasi: services/whatsapp-bot-ai/memory/store.js
// Deskripsi: Abstraksi persistensi memori ke PostgreSQL.
// Fase 1a: persist recent memory (personal chat)
// Fase 1b: grup chat + assistant response + metadata enrichment
// Fase 1c: idempotency via external_message_id + content truncation
// Fase 1d: emoji-safe truncation (code-point aware) + assistant idempotency
// Fase 2  (TASK-055): durable memory API (saveDurable, findSimilar, consolidate)
//
// API:
//   - saveMessage / saveAssistantResponse / getRecentTurns / getAllRecentTurns
//   - purgeExpired / countByScope / truncateContent
//   - saveExplicitMemory / getExplicitMemory / listExplicitMemory / deleteExplicitMemory
//   - saveDurableMemory / getDurableMemory / listDurableMemory / findSimilarDurable
//   - mergeDurableMemories / markConsolidated / runConsolidationJob
//
// Referensi: docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md § Class Diagram
// ==============================================================================

'use strict';

const db = require('./db');

const DEFAULT_LIMIT = parseInt(process.env.WHATSAPP_MEMORY_RECENT_LIMIT || '10', 10);
const RETENTION_DAYS = parseInt(process.env.WHATSAPP_MEMORY_RETENTION_DAYS || '30', 10);
const MAX_CONTENT_LENGTH = parseInt(process.env.WHATSAPP_MEMORY_MAX_CONTENT || '4000', 10);

// TASK-055 Fase 2: thresholds untuk ConsolidationJob
const CONSOLIDATION_SIMILARITY_THRESHOLD = parseFloat(
  process.env.WHATSAPP_MEMORY_CONSOLIDATION_SIMILARITY || '0.85'
);
const CONSOLIDATION_BATCH_SIZE = parseInt(
  process.env.WHATSAPP_MEMORY_CONSOLIDATION_BATCH || '50'
);
const EMBEDDING_DIM = 384;  // nomic-embed-text output dim

// =============================================================================
// Helper: code-point aware truncation (TASK-050 Fase 1d)
// =============================================================================
function truncateContent(content) {
  if (typeof content !== 'string') return { content: String(content || ''), truncated: false, originalLength: 0 };
  if (content.length <= MAX_CONTENT_LENGTH) {
    return { content, truncated: false, originalLength: content.length };
  }
  const codePoints = Array.from(content);
  if (codePoints.length <= MAX_CONTENT_LENGTH) {
    return { content, truncated: false, originalLength: content.length };
  }
  return {
    content: codePoints.slice(0, MAX_CONTENT_LENGTH).join(''),
    truncated: true,
    originalLength: content.length,
  };
}

// =============================================================================
// Recent / Assistant memory (Fase 1a + 1b + 1c + 1d)
// =============================================================================
async function saveMessage(scopeType, scopeId, role, content, opts = {}) {
  const {
    memoryType = 'recent',
    source = 'inferred',
    confidenceScore = 1.0,
    metadata = {},
    quotedMessageId = null,
    externalMessageId = null,
  } = opts;

  const trunc = truncateContent(content);
  const finalMetadata = { ...metadata };
  if (quotedMessageId) finalMetadata.quoted_message_id = quotedMessageId;
  if (trunc.truncated) {
    finalMetadata.truncated = true;
    finalMetadata.original_length = trunc.originalLength;
  }

  const sql = externalMessageId
    ? `
      INSERT INTO whatsapp_bot.memories
        (scope_type, scope_id, memory_type, role, content, source, confidence_score, metadata, external_message_id)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      ON CONFLICT (scope_type, scope_id, external_message_id)
        WHERE external_message_id IS NOT NULL
        DO NOTHING
      RETURNING id, created_at, expires_at
    `
    : `
      INSERT INTO whatsapp_bot.memories
        (scope_type, scope_id, memory_type, role, content, source, confidence_score, metadata)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      RETURNING id, created_at, expires_at
    `;

  const params = externalMessageId
    ? [scopeType, scopeId, memoryType, role, trunc.content, source, confidenceScore, JSON.stringify(finalMetadata), externalMessageId]
    : [scopeType, scopeId, memoryType, role, trunc.content, source, confidenceScore, JSON.stringify(finalMetadata)];

  try {
    const { rows } = await db.query(sql, params);
    if (rows.length === 0) {
      console.log(`[memory/store] ⏭️ Deduplicated (scope=${scopeType}:${scopeId}, ext_id=${externalMessageId})`);
      return { id: null, created_at: null, expires_at: null, deduplicated: true };
    }
    return {
      id: rows[0].id,
      created_at: rows[0].created_at,
      expires_at: rows[0].expires_at,
      deduplicated: false,
    };
  } catch (err) {
    console.error(`[memory/store] ❌ saveMessage error (scope=${scopeType}:${scopeId}):`, err.message);
    throw err;
  }
}

async function saveAssistantResponse(scopeType, scopeId, content, metadata = {}, externalMessageId = null) {
  return saveMessage(scopeType, scopeId, 'assistant', content, {
    memoryType: 'recent',
    source: 'external',
    confidenceScore: 1.0,
    metadata: { ...metadata, is_assistant: true },
    externalMessageId,
  });
}

async function getRecentTurns(scopeType, scopeId, limit = DEFAULT_LIMIT) {
  const sql = `
    SELECT role, content, created_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1 AND scope_id = $2
      AND memory_type = 'recent'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT $3
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, limit]);
    return rows.reverse();
  } catch (err) {
    console.error(`[memory/store] ❌ getRecentTurns error:`, err.message);
    return [];
  }
}

async function getAllRecentTurns(scopeType, scopeId, limit = DEFAULT_LIMIT) {
  const sql = `
    SELECT id, role, content, source, confidence_score, metadata, created_at, expires_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1 AND scope_id = $2
      AND memory_type = 'recent'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT $3
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, limit]);
    return rows.reverse();
  } catch (err) {
    console.error('[memory/store] ❌ getAllRecentTurns error:', err.message);
    return [];
  }
}

async function purgeExpired() {
  const sql = `DELETE FROM whatsapp_bot.memories WHERE expires_at IS NOT NULL AND expires_at < NOW() RETURNING id`;
  try {
    const { rows } = await db.query(sql, []);
    const count = rows.length;
    if (count > 0) console.log(`[memory/store] 🧹 Purged ${count} expired memories`);
    return count;
  } catch (err) {
    console.error('[memory/store] ❌ purgeExpired error:', err.message);
    return 0;
  }
}

async function countByScope(scopeType, scopeId, memoryType = 'recent') {
  const sql = `
    SELECT COUNT(*)::int AS n
    FROM whatsapp_bot.memories
    WHERE scope_type = $1 AND scope_id = $2 AND memory_type = $3
      AND (expires_at IS NULL OR expires_at > NOW())
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, memoryType]);
    return rows[0].n;
  } catch (err) {
    console.error('[memory/store] ❌ countByScope error:', err.message);
    return 0;
  }
}

// =============================================================================
// TASK-054 (Fase 5): Explicit & Profile memory API
// =============================================================================
async function saveExplicitMemory(scopeType, scopeId, key, value, opts = {}) {
  const { source = 'explicit', memoryType = 'explicit', metadata = {} } = opts;
  if (!scopeType || !scopeId || !key || !value) {
    throw new Error('[memory/store] saveExplicitMemory: scopeType, scopeId, key, value wajib diisi');
  }
  if (!['explicit', 'profile'].includes(memoryType)) {
    throw new Error(`[memory/store] memoryType harus 'explicit' atau 'profile' (got '${memoryType}')`);
  }
  const finalMetadata = { ...metadata, key };
  const findSql = `
    SELECT id, version FROM whatsapp_bot.memories
    WHERE scope_type=$1 AND scope_id=$2 AND memory_type=$3
      AND metadata->>'key'=$4
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  const findRes = await db.query(findSql, [scopeType, scopeId, memoryType, key]);
  if (findRes.rows.length > 0) {
    const existingId = findRes.rows[0].id;
    const newVersion = findRes.rows[0].version + 1;
    await db.query(
      `UPDATE whatsapp_bot.memories SET content=$1, version=$2, updated_at=NOW(), source=$3 WHERE id=$4`,
      [value, newVersion, source, existingId]
    );
    return { id: existingId, is_insert: false, version: newVersion };
  }
  const insRes = await db.query(
    `INSERT INTO whatsapp_bot.memories
       (scope_type, scope_id, memory_type, role, content, source, confidence_score, version, metadata, expires_at)
     VALUES ($1,$2,$3,'user',$4,$5,1.0,1,$6::jsonb,NULL)
     RETURNING id`,
    [scopeType, scopeId, memoryType, value, source, JSON.stringify(finalMetadata)]
  );
  return { id: insRes.rows[0].id, is_insert: true, version: 1 };
}

async function getExplicitMemory(scopeType, scopeId, key, memoryType = 'explicit') {
  const sql = `
    SELECT id, content, version, metadata, created_at, updated_at
    FROM whatsapp_bot.memories
    WHERE scope_type=$1 AND scope_id=$2 AND memory_type=$3
      AND metadata->>'key'=$4
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY version DESC LIMIT 1
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, memoryType, key]);
  return rows[0] || null;
}

async function listExplicitMemory(scopeType, scopeId, memoryType = 'explicit', limit = 50) {
  const sql = `
    SELECT metadata->>'key' AS key, content, version, updated_at
    FROM whatsapp_bot.memories
    WHERE scope_type=$1 AND scope_id=$2 AND memory_type=$3
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY updated_at DESC LIMIT $4
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, memoryType, limit]);
  return rows;
}

async function deleteExplicitMemory(scopeType, scopeId, key, memoryType = 'explicit') {
  const res = await db.query(
    `DELETE FROM whatsapp_bot.memories
     WHERE scope_type=$1 AND scope_id=$2 AND memory_type=$3 AND metadata->>'key'=$4`,
    [scopeType, scopeId, memoryType, key]
  );
  return { deleted_count: res.rowCount };
}

// =============================================================================
// TASK-055 (Fase 2): Durable memory API + ConsolidationJob
// =============================================================================
// `durable` = fakta jangka panjang hasil ekstraksi LLM dari chat history.
// Berbeda dengan `explicit` yang user-input manual.
// - Disimpan dengan embedding (nomic-embed-text, 384-dim) untuk semantic search.
// - ConsolidationJob: cron harian, scan row yang belum consolidated, similarity
//   check via embedding, merge yang mirip (similarity >= threshold).
// =============================================================================

/**
 * Simpan durable memory + embedding vector (384-dim).
 * - memory_type = 'durable'
 * - Tidak expire (durable = persistent)
 * - Embedding WAJIB diisi (akan ditolak jika NULL).
 *
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} content   fakta / ringkasan
 * @param {object} [opts]
 * @param {number[]} [opts.embedding]   array 384-dim (akan divalidasi)
 * @param {string} [opts.source='inferred']
 * @param {string} [opts.role='user']
 * @param {number} [opts.confidenceScore=1.0]
 * @param {object} [opts.metadata={}]
 * @param {number[]} [opts.sourceMemoryIds]  row ID asal (untuk merge history)
 * @returns {Promise<{id, is_insert, embedding_dim}>}
 */
async function saveDurableMemory(scopeType, scopeId, content, opts = {}) {
  const {
    embedding = null,
    source = 'inferred',
    role = 'user',
    confidenceScore = 1.0,
    metadata = {},
    sourceMemoryIds = null,
  } = opts;

  if (!scopeType || !scopeId || !content) {
    throw new Error('[memory/store] saveDurableMemory: scopeType, scopeId, content wajib diisi');
  }
  if (!embedding || !Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
    throw new Error(
      `[memory/store] saveDurableMemory: embedding harus array of ${EMBEDDING_DIM} floats (got ${
        embedding ? embedding.length : 'null'
      })`
    );
  }

  const embeddingStr = '[' + embedding.map((f) => Number(f).toFixed(8)).join(',') + ']';

  const sql = `
    INSERT INTO whatsapp_bot.memories
      (scope_type, scope_id, memory_type, role, content, source, confidence_score, metadata, expires_at, embedding, source_memory_ids)
    VALUES
      ($1, $2, 'durable', $3, $4, $5, $6, $7::jsonb, NULL, $8::vector, $9::bigint[])
    RETURNING id, embedding IS NOT NULL AS has_embedding
  `;
  const finalMetadata = { ...metadata, durable_extracted_at: new Date().toISOString() };
  const { rows } = await db.query(sql, [
    scopeType,
    scopeId,
    role,
    content,
    source,
    confidenceScore,
    JSON.stringify(finalMetadata),
    embeddingStr,
    sourceMemoryIds,
  ]);
  return {
    id: rows[0].id,
    is_insert: true,
    has_embedding: rows[0].has_embedding,
    embedding_dim: EMBEDDING_DIM,
  };
}

/**
 * Ambil durable memory by ID.
 */
async function getDurableMemory(memoryId) {
  const sql = `
    SELECT id, scope_type, scope_id, content, source, confidence_score, version, metadata,
           external_message_id, consolidated_at, source_memory_ids,
           created_at, updated_at, embedding IS NOT NULL AS has_embedding
    FROM whatsapp_bot.memories
    WHERE id = $1 AND memory_type = 'durable'
  `;
  const { rows } = await db.query(sql, [memoryId]);
  return rows[0] || null;
}

/**
 * List durable memory untuk scope tertentu, urut terbaru.
 */
async function listDurableMemory(scopeType, scopeId, limit = 50) {
  const sql = `
    SELECT id, content, source, confidence_score, version, metadata,
           consolidated_at, created_at, updated_at
    FROM whatsapp_bot.memories
    WHERE scope_type=$1 AND scope_id=$2 AND memory_type='durable'
    ORDER BY created_at DESC LIMIT $3
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, limit]);
  return rows;
}

/**
 * Cari top-K durable memory yang paling MIRIP dengan embedding query (cosine).
 * - Menggunakan pgvector <=> (cosine distance).
 * - Falls back ke text similarity (LIKE) jika pgvector tidak tersedia.
 *
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {number[]} queryEmbedding  array 384-dim
 * @param {number} [k=5]
 * @param {number} [minSimilarity=0.7]  cosine similarity threshold (0..1)
 * @returns {Promise<Array<{id, content, similarity, ...}>>}
 */
async function findSimilarDurable(scopeType, scopeId, queryEmbedding, k = 5, minSimilarity = 0.7, textHint = '') {
  if (!queryEmbedding || queryEmbedding.length !== EMBEDDING_DIM) {
    throw new Error(`[memory/store] findSimilarDurable: queryEmbedding harus ${EMBEDDING_DIM}-dim`);
  }
  const embeddingStr = '[' + queryEmbedding.map((f) => Number(f).toFixed(8)).join(',') + ']';

  // Cek apakah pgvector aktif (kolom embedding ada)
  let hasVector = false;
  try {
    const probe = await db.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='whatsapp_bot' AND table_name='memories' AND column_name='embedding' LIMIT 1`
    );
    hasVector = probe.rows.length > 0;
  } catch (e) {
    hasVector = false;
  }

  if (hasVector) {
    const sql =`
      SELECT
        id, content, source, confidence_score, version, metadata,
        consolidated_at, created_at, updated_at,
        1 - (embedding <=> $4::vector) AS similarity
      FROM whatsapp_bot.memories
      WHERE scope_type=$1 AND scope_id=$2 AND memory_type='durable'
        AND embedding IS NOT NULL
        AND (1 - (embedding <=> $4::vector)) >= $5
      ORDER BY embedding <=> $4::vector
      LIMIT $3
    `;
    const { rows } = await db.query(sql, [scopeType, scopeId, k, embeddingStr, minSimilarity]);
    return rows;
  }

  // Fallback: text similarity via ILIKE (best-effort, tidak se-akurat embedding)
  // Untuk nama / keyword sederhana saja.
  console.warn('[memory/store] ⚠️ pgvector tidak aktif — findSimilarDurable fallback ke ILIKE');
  const sql = `
    SELECT id, content, source, confidence_score, version, metadata,
           consolidated_at, created_at, updated_at,
           0.5::float AS similarity
    FROM whatsapp_bot.memories
    WHERE scope_type=$1 AND scope_id=$2 AND memory_type='durable'
      AND content ILIKE $3
    ORDER BY created_at DESC LIMIT $4
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, '%' + (textHint || '') + '%', k]);
  return rows;
}

/**
 * Merge N durable memory rows menjadi 1 (ConsolidationJob).
 * - Pilih row pertama sebagai "winner" (idempotent, version++).
 * - Append content dari row lain ke content winner dengan separator.
 * - Track source_memory_ids untuk audit.
 * - Mark consolidated_at di winner.
 * - Row "loser" di-soft-delete (expires_at = NOW()) agar tidak muncul di query,
 *   tapi tetap ada untuk audit history.
 *
 * @param {number[]} memoryIds  list of durable memory IDs to merge (min 2)
 * @param {object} [opts]
 * @param {string} [opts.mergeStrategy='append']  'append' | 'replace_winner' | 'longest'
 * @returns {Promise<{winner_id, merged_from, merged_count, new_version}>}
 */
async function mergeDurableMemories(memoryIds, opts = {}) {
  const { mergeStrategy = 'append' } = opts;
  if (!Array.isArray(memoryIds) || memoryIds.length < 2) {
    throw new Error('[memory/store] mergeDurableMemories: butuh >= 2 memory IDs');
  }
  // Ambil semua row
  const idsStr = memoryIds.join(',');
  const selectSql = `
    SELECT id, content, version, source_memory_ids, confidence_score, metadata
    FROM whatsapp_bot.memories
    WHERE id = ANY($1::bigint[]) AND memory_type = 'durable'
    ORDER BY created_at ASC
  `;
  const { rows } = await db.query(selectSql, [memoryIds]);
  if (rows.length < 2) {
    throw new Error(`[memory/store] mergeDurableMemories: hanya ${rows.length} row ditemukan (butuh >= 2)`);
  }
  const winner = rows[0];
  const losers = rows.slice(1);

  // Build content gabungan
  let mergedContent = winner.content;
  const mergedSourceIds = new Set(winner.source_memory_ids || []);
  for (const l of losers) {
    if (mergeStrategy === 'append') {
      mergedContent += '\n---\n' + l.content;
    } else if (mergeStrategy === 'longest' && l.content.length > mergedContent.length) {
      mergedContent = l.content;
    }
    if (Array.isArray(l.source_memory_ids)) {
      l.source_memory_ids.forEach((id) => mergedSourceIds.add(Number(id)));
    }
    mergedSourceIds.add(l.id);
  }
  // Tambah winner.id juga
  mergedSourceIds.add(winner.id);

  // Update winner
  const newVersion = winner.version + 1;
  const updSql = `
    UPDATE whatsapp_bot.memories
    SET content = $1,
        version = $2,
        updated_at = NOW(),
        consolidated_at = NOW(),
        source_memory_ids = $3::bigint[],
        metadata = metadata || $4::jsonb
    WHERE id = $5
    RETURNING id, version
  `;
  const newMeta = { ...(winner.metadata || {}), last_merged_at: new Date().toISOString(), merge_strategy: mergeStrategy };
  await db.query(updSql, [mergedContent, newVersion, Array.from(mergedSourceIds), JSON.stringify(newMeta), winner.id]);

  // Soft-delete losers (set expires_at = NOW()) — tidak dihapus permanen agar history ada
  const softDelSql = `
    UPDATE whatsapp_bot.memories
    SET expires_at = NOW(),
        metadata = metadata || $1::jsonb
    WHERE id = ANY($2::bigint[])
  `;
  const loserMeta = { merged_into: winner.id, soft_deleted_reason: 'consolidation_merge' };
  await db.query(softDelSql, [JSON.stringify(loserMeta), losers.map((l) => l.id)]);

  console.log(
    `[memory/store] 🔀 Merged ${rows.length} durable memories → winner id=${winner.id} (v${newVersion}, losers soft-deleted)`
  );
  return {
    winner_id: winner.id,
    merged_from: memoryIds,
    merged_count: rows.length,
    new_version: newVersion,
  };
}

/**
 * Mark durable memory sebagai sudah di-consolidate (audit trail).
 * @param {number} memoryId
 * @returns {Promise<{id, consolidated_at}>}
 */
async function markConsolidated(memoryId) {
  const sql = `
    UPDATE whatsapp_bot.memories
    SET consolidated_at = NOW()
    WHERE id = $1 AND memory_type = 'durable' AND consolidated_at IS NULL
    RETURNING id, consolidated_at
  `;
  const { rows } = await db.query(sql, [memoryId]);
  return rows[0] || null;
}

/**
 * ConsolidationJob: scan durable memory yang belum di-consolidate, cari
 * yang mirip (cosine similarity >= threshold), dan merge.
 *
 * Strategi:
 * 1. Ambil semua durable memory di (scope_type, scope_id) yang consolidated_at IS NULL
 * 2. Untuk setiap row, cari top-K yang mirip via embedding
 * 3. Jika ada row dengan similarity >= threshold → merge
 * 4. Mark winner consolidated
 * 5. Return statistik
 *
 * @param {object} [opts]
 * @param {number} [opts.batchSize=50]
 * @param {number} [opts.similarityThreshold=0.85]
 * @param {string} [opts.scopeType]   jika null, scan semua scope
 * @returns {Promise<{scanned, merged, errors, duration_ms}>}
 */
async function runConsolidationJob(opts = {}) {
  const start = Date.now();
  const {
    batchSize = CONSOLIDATION_BATCH_SIZE,
    similarityThreshold = CONSOLIDATION_SIMILARITY_THRESHOLD,
    scopeType = null,
  } = opts;
  console.log(
    `[memory/store] 🧠 ConsolidationJob mulai (batch=${batchSize}, threshold=${similarityThreshold})`
  );

  // 1. Ambil kandidat (row yang belum di-consolidate, ada embedding)
  const candSql = `
    SELECT id, scope_type, scope_id, content, embedding
    FROM whatsapp_bot.memories
    WHERE memory_type = 'durable'
      AND consolidated_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
      ${scopeType ? 'AND scope_type = $2' : ''}
    ORDER BY created_at ASC
    LIMIT $1
  `;
  const candParams = scopeType ? [batchSize, scopeType] : [batchSize];
  const { rows: candidates } = await db.query(candSql, candParams);

  let scanned = candidates.length;
  let merged = 0;
  let errors = 0;

  for (const cand of candidates) {
    if (!cand.embedding) continue;  // skip row tanpa embedding

    // 2. Cari top-5 mirip
    const sims = await findSimilarDurable(
      cand.scope_type,
      cand.scope_id,
      cand.embedding,  // reuse embedding (sudah string di-row)
      5,
      similarityThreshold
    ).catch((e) => {
      console.warn(`[memory/store] ⚠️ findSimilarDurable error:`, e.message);
      errors += 1;
      return [];
    });

    if (sims.length >= 2) {
      // 3. Merge cand + sims (exclude self)
      const idsToMerge = [cand.id, ...sims.filter((s) => s.id !== cand.id).map((s) => s.id)];
      try {
        await mergeDurableMemories(idsToMerge, { mergeStrategy: 'append' });
        merged += 1;
      } catch (e) {
        console.warn(`[memory/store] ⚠️ merge error for id=${cand.id}:`, e.message);
        errors += 1;
      }
    } else {
      // Tidak ada yang mirip, mark consolidated (sudah diproses)
      await markConsolidated(cand.id).catch(() => {});
    }
  }

  const duration = Date.now() - start;
  console.log(
    `[memory/store] 🧠 ConsolidationJob selesai: scanned=${scanned}, merged=${merged}, errors=${errors}, duration=${duration}ms`
  );
  return { scanned, merged, errors, duration_ms: duration };
}

module.exports = {
  // Fase 1a-1d
  saveMessage,
  saveAssistantResponse,
  getRecentTurns,
  getAllRecentTurns,
  purgeExpired,
  countByScope,
  truncateContent,
  // TASK-054 (Fase 5)
  saveExplicitMemory,
  getExplicitMemory,
  listExplicitMemory,
  deleteExplicitMemory,
  // TASK-055 (Fase 2)
  saveDurableMemory,
  getDurableMemory,
  listDurableMemory,
  findSimilarDurable,
  mergeDurableMemories,
  markConsolidated,
  runConsolidationJob,
  // Constants
  RETENTION_DAYS,
  DEFAULT_LIMIT,
  MAX_CONTENT_LENGTH,
  CONSOLIDATION_SIMILARITY_THRESHOLD,
  CONSOLIDATION_BATCH_SIZE,
  EMBEDDING_DIM,
};
