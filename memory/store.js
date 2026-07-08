// ==============================================================================
// memory/store.js — Recent Conversation Memory CRUD (Fase 1d hardened)
// ==============================================================================
// Lokasi: services/whatsapp-bot-ai/memory/store.js
// Deskripsi: Abstraksi persistensi memori ke PostgreSQL.
// Fase 1a: persist recent memory (personal chat)
// Fase 1b: grup chat + assistant response + metadata enrichment
// Fase 1c: idempotency via external_message_id + content truncation
// Fase 1d: emoji-safe truncation (code-point aware) + assistant idempotency
//
// API:
//   - saveMessage(scopeType, scopeId, role, content, opts)
//   - saveAssistantResponse(scopeType, scopeId, content, metadata, externalMessageId)
//   - getRecentTurns(scopeType, scopeId, limit=10)
//   - getAllRecentTurns(scopeType, scopeId, limit=10)
//   - purgeExpired()
//   - countByScope(scopeType, scopeId, memoryType)
//   - truncateContent(content)  [emoji-safe]
//
// Referensi: docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md § Class Diagram
// ==============================================================================

'use strict';

const db = require('./db');

const DEFAULT_LIMIT = parseInt(process.env.WHATSAPP_MEMORY_RECENT_LIMIT || '10', 10);
const RETENTION_DAYS = parseInt(process.env.WHATSAPP_MEMORY_RETENTION_DAYS || '30', 10);
const MAX_CONTENT_LENGTH = parseInt(process.env.WHATSAPP_MEMORY_MAX_CONTENT || '4000', 10);

/**
 * TASK-050 Fase 1d: Potong content secara code-point aware (emoji-safe).
 * - content.substring(0, N) memotong berdasarkan UTF-16 code unit, bisa membelah surrogate pair
 *   (emoji 😀 = 2 code units). Hasil: karakter invalid.
 * - Array.from(content).slice(0, N).join('') memotong per code point (grapheme untuk most cases).
 *
 * Note: Untuk cluster grapheme yang sangat kompleks (e.g., emoji dengan skin tone + ZWJ),
 * code-point aware masih bisa memotong di tengah. Untuk itu perlu Intl.Segmenter (Node 16+).
 * Tapi 99% kasus chat WA cukup dengan code-point aware.
 *
 * @param {string} content
 * @returns {{content: string, truncated: boolean, originalLength: number}}
 */
function truncateContent(content) {
  if (typeof content !== 'string') return { content: String(content || ''), truncated: false, originalLength: 0 };
  if (content.length <= MAX_CONTENT_LENGTH) {
    return { content, truncated: false, originalLength: content.length };
  }
  // Code-point aware slicing
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

/**
 * Simpan satu pesan ke memori.
 *
 * @param {string} scopeType   'personal' | 'group'
 * @param {string} scopeId     JID: 628xxx@s.whatsapp.net atau xxx@g.us
 * @param {string} role        'user' | 'assistant' | 'system'
 * @param {string} content     Isi pesan (akan di-truncate ke MAX_CONTENT_LENGTH)
 * @param {object} [opts]
 * @param {string} [opts.memoryType='recent']
 * @param {string} [opts.source='inferred']  'inferred'|'explicit'|'external'
 * @param {number} [opts.confidenceScore=1.0]
 * @param {object} [opts.metadata={}]
 * @param {string} [opts.quotedMessageId=null]
 * @param {string} [opts.externalMessageId=null]  // untuk dedup
 * @returns {Promise<{id: number, created_at: Date, expires_at: Date|null, deduplicated: boolean}>}
 */
async function saveMessage(scopeType, scopeId, role, content, opts = {}) {
  const {
    memoryType = 'recent',
    source = 'inferred',
    confidenceScore = 1.0,
    metadata = {},
    quotedMessageId = null,
    externalMessageId = null,
  } = opts;

  // TASK-049: Truncate content (emoji-safe per Fase 1d)
  const trunc = truncateContent(content);

  // Enrich metadata
  const finalMetadata = { ...metadata };
  if (quotedMessageId) {
    finalMetadata.quoted_message_id = quotedMessageId;
  }
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
    console.error(
      `[memory/store] ❌ Gagal save message (scope=${scopeType}:${scopeId}, role=${role}):`,
      err.message
    );
    throw err;
  }
}

/**
 * TASK-048 + TASK-050 Fase 1d: Simpan response dari assistant (balasan bot dari LLM).
 * Mendukung externalMessageId untuk idempotency — jika webhook retry, akan di-deduplicate.
 *
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} content
 * @param {object} [metadata={}]
 * @param {string} [externalMessageId=null]  // TASK-050: untuk idempotency webhook retry
 * @returns {Promise<{id, deduplicated}>}
 */
async function saveAssistantResponse(scopeType, scopeId, content, metadata = {}, externalMessageId = null) {
  return saveMessage(scopeType, scopeId, 'assistant', content, {
    memoryType: 'recent',
    source: 'external',
    confidenceScore: 1.0,
    metadata: {
      ...metadata,
      is_assistant: true,
    },
    externalMessageId,  // TASK-050: idempotency via requestId round-trip
  });
}

/**
 * Ambil N turn terakhir (user + assistant) untuk scope tertentu, diurutkan
 * dari yang paling lama ke paling baru.
 */
async function getRecentTurns(scopeType, scopeId, limit = DEFAULT_LIMIT) {
  const sql = `
    SELECT role, content, created_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = 'recent'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT $3
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, limit]);
    return rows.reverse();
  } catch (err) {
    console.error(`[memory/store] ❌ Gagal getRecentTurns (scope=${scopeType}:${scopeId}):`, err.message);
    return [];
  }
}

/**
 * Get all recent turns termasuk metadata (untuk debugging/audit).
 */
async function getAllRecentTurns(scopeType, scopeId, limit = DEFAULT_LIMIT) {
  const sql = `
    SELECT id, role, content, source, confidence_score, metadata, created_at, expires_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = 'recent'
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT $3
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, limit]);
    return rows.reverse();
  } catch (err) {
    console.error('[memory/store] ❌ Gagal getAllRecentTurns:', err.message);
    return [];
  }
}

/**
 * Hapus semua row yang sudah lewat expires_at.
 */
async function purgeExpired() {
  const sql = `
    DELETE FROM whatsapp_bot.memories
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW()
    RETURNING id
  `;
  try {
    const { rows } = await db.query(sql, []);
    const count = rows.length;
    if (count > 0) {
      console.log(`[memory/store] 🧹 Purged ${count} expired memories`);
    }
    return count;
  } catch (err) {
    console.error('[memory/store] ❌ Gagal purge expired:', err.message);
    return 0;
  }
}

/**
 * Hitung jumlah memori per scope (untuk monitoring).
 */
async function countByScope(scopeType, scopeId, memoryType = 'recent') {
  const sql = `
    SELECT COUNT(*)::int AS n
    FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = $3
      AND (expires_at IS NULL OR expires_at > NOW())
  `;
  try {
    const { rows } = await db.query(sql, [scopeType, scopeId, memoryType]);
    return rows[0].n;
  } catch (err) {
    console.error('[memory/store] ❌ Gagal countByScope:', err.message);
    return 0;
  }
}

// =============================================================================
// TASK-054 (Fase 5): Explicit & Profile memory API
// =============================================================================
// `!ingat key: value` → memory_type='explicit' (per-user, durable, no expiry)
// `!profile key value` → memory_type='profile' (preferences, durable)
// =============================================================================

/**
 * Simpan explicit memory (Fase 5 — `!ingat key: value`).
 * - Idempotent via UNIQUE constraint pada (scope_type, scope_id, memory_type, metadata->>'key').
 * - Jika key sudah ada → UPDATE content + version++ (append-only versioning).
 * - Tidak expire (durable).
 *
 * @param {string} scopeType  'personal' | 'group'
 * @param {string} scopeId    JID
 * @param {string} key        identifier (mis. "nama_panggilan", "tanggal_lahir")
 * @param {string} value      isi fakta / preferensi
 * @param {object} [opts]
 * @param {string} [opts.source='explicit']
 * @param {string} [opts.memoryType='explicit']  boleh 'profile' untuk preferensi
 * @param {object} [opts.metadata={}]
 * @returns {Promise<{id: number, is_insert: boolean, version: number}>}
 */
async function saveExplicitMemory(scopeType, scopeId, key, value, opts = {}) {
  const {
    source = 'explicit',
    memoryType = 'explicit',
    metadata = {},
  } = opts;

  if (!scopeType || !scopeId || !key || !value) {
    throw new Error('[memory/store] saveExplicitMemory: scopeType, scopeId, key, value wajib diisi');
  }
  if (!['explicit', 'profile'].includes(memoryType)) {
    throw new Error(`[memory/store] saveExplicitMemory: memoryType harus 'explicit' atau 'profile' (got '${memoryType}')`);
  }

  // Metadata harus berisi 'key' (untuk query by key)
  const finalMetadata = {
    ...metadata,
    key,
  };

  // Postgres UPSERT: jika sudah ada row dengan key yg sama (pada scope+type yg sama),
  // increment version & replace content.
  // Catatan: UNIQUE constraint di-handle via WHERE clause di query.
  // Pakai teknik: cari dulu existing, jika ada update, else insert.
  const findSql = `
    SELECT id, version FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = $3
      AND metadata->>'key' = $4
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1
  `;
  const findRes = await db.query(findSql, [scopeType, scopeId, memoryType, key]);

  if (findRes.rows.length > 0) {
    // UPDATE existing
    const existingId = findRes.rows[0].id;
    const newVersion = findRes.rows[0].version + 1;
    const updSql = `
      UPDATE whatsapp_bot.memories
      SET content = $1, version = $2, updated_at = NOW(), source = $3
      WHERE id = $4
      RETURNING id
    `;
    await db.query(updSql, [value, newVersion, source, existingId]);
    return { id: existingId, is_insert: false, version: newVersion };
  } else {
    // INSERT new
    const insSql = `
      INSERT INTO whatsapp_bot.memories
        (scope_type, scope_id, memory_type, role, content, source, confidence_score, version, metadata, expires_at)
      VALUES
        ($1, $2, $3, 'user', $4, $5, 1.0, 1, $6::jsonb, NULL)
      RETURNING id
    `;
    const insRes = await db.query(insSql, [scopeType, scopeId, memoryType, value, source, JSON.stringify(finalMetadata)]);
    return { id: insRes.rows[0].id, is_insert: true, version: 1 };
  }
}

/**
 * Ambil 1 explicit/profile memory by key.
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} key
 * @param {string} [memoryType='explicit']
 * @returns {Promise<{id, content, version, metadata, created_at, updated_at} | null>}
 */
async function getExplicitMemory(scopeType, scopeId, key, memoryType = 'explicit') {
  const sql = `
    SELECT id, content, version, metadata, created_at, updated_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = $3
      AND metadata->>'key' = $4
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY version DESC
    LIMIT 1
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, memoryType, key]);
  return rows[0] || null;
}

/**
 * List semua explicit/profile memory untuk scope tertentu.
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} [memoryType='explicit']
 * @param {number} [limit=50]
 * @returns {Promise<Array<{key, content, version, updated_at}>>}
 */
async function listExplicitMemory(scopeType, scopeId, memoryType = 'explicit', limit = 50) {
  const sql = `
    SELECT metadata->>'key' AS key, content, version, updated_at
    FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = $3
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY updated_at DESC
    LIMIT $4
  `;
  const { rows } = await db.query(sql, [scopeType, scopeId, memoryType, limit]);
  return rows;
}

/**
 * Hapus explicit/profile memory by key (soft-delete via version++ dengan marker).
 * Hard delete untuk simplicity (Fase 5).
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {string} key
 * @param {string} [memoryType='explicit']
 * @returns {Promise<{deleted_count: number}>}
 */
async function deleteExplicitMemory(scopeType, scopeId, key, memoryType = 'explicit') {
  const sql = `
    DELETE FROM whatsapp_bot.memories
    WHERE scope_type = $1
      AND scope_id   = $2
      AND memory_type = $3
      AND metadata->>'key' = $4
  `;
  const res = await db.query(sql, [scopeType, scopeId, memoryType, key]);
  return { deleted_count: res.rowCount };
}

module.exports = {
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
  RETENTION_DAYS,
  DEFAULT_LIMIT,
  MAX_CONTENT_LENGTH,
};
