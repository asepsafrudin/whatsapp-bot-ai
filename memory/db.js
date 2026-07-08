// ==============================================================================
// memory/db.js — PostgreSQL Pool Wrapper
// ==============================================================================
// Lokasi: services/whatsapp-bot-ai/memory/db.js
// Deskripsi: Wrapper tipis di atas `pg` (node-postgres) untuk koneksi ke
//            database PostgreSQL terpusat (`mcp_knowledge`, schema `whatsapp_bot`).
//
// Konfigurasi: baca dari process.env yang sudah di-load oleh `dotenv` di
//               index.js (yang mengarah ke `../../.env` atau env hierarkis).
//
// Referensi: docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md
// ==============================================================================

'use strict';

const { Pool, types } = require('pg');

// =============================================================================
// TASK-055 Fase 2 (bugfix): Daftarkan type parser untuk tipe `vector` (pgvector)
// =============================================================================
// node-postgres secara default tidak mengenali tipe custom `vector` dari
// pgvector. Hasilnya, nilai embedding dikembalikan sebagai string
// "[0.12,0.34,...]" bukan array of float — yang akan memecah logika
// yang mengandalkan `embedding.length`.
//
// Solusi: daftarkan type parser yang mem-parse string pgvector menjadi
// array of float. OID tipe vector (biasanya 16385 atau 16386) di-resolve
// lewat pg_type saat inisialisasi.
//
// Referensi: https://github.com/brianc/node-pg-types
// =============================================================================
const PGVECTOR_TYPE_PARSERS = new Map();

function parsePgvectorToFloatArray(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return value;  // sudah array atau bukan string
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Hapus bracket luar lalu split
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '');
  return inner.split(',').map((s) => Number(s.trim()));
}

async function registerPgvectorTypeParser(client) {
  try {
    // Cari OID untuk tipe `vector` dan `vecf16` (jika ada)
    const { rows } = await client.query(
      `SELECT oid, typname FROM pg_type WHERE typname IN ('vector', '_vector')`
    );
    for (const r of rows) {
      const oid = Number(r.oid);
      if (!PGVECTOR_TYPE_PARSERS.has(oid)) {
        types.setTypeParser(oid, parsePgvectorToFloatArray);
        PGVECTOR_TYPE_PARSERS.set(oid, r.typname);
      }
    }
    if (PGVECTOR_TYPE_PARSERS.size > 0) {
      console.log(
        `[memory/db] ✅ Registered pgvector type parser for OIDs: ` +
        Array.from(PGVECTOR_TYPE_PARSERS.entries()).map(([o, n]) => `${n}=${o}`).join(', ')
      );
    }
  } catch (e) {
    // Tidak fatal — store.js sudah punya safety net via parseEmbedding()
    console.warn('[memory/db] ⚠️ Gagal register pgvector type parser:', e.message);
  }
}

// Tentukan connection string: prioritas DATABASE_URL, fallback ke POSTGRES_*
const connectionString =
  process.env.DATABASE_URL ||
  process.env.WHATSAPP_MEMORY_DATABASE_URL ||
  (process.env.POSTGRES_HOST
    ? `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT || 5432}/${process.env.POSTGRES_DB}`
    : null);

if (!connectionString) {
  console.error(
    '[memory/db] ❌ FATAL: Tidak ada konfigurasi database. Set DATABASE_URL atau variabel POSTGRES_*.'
  );
  // Jangan throw — biarkan caller yang memutuskan fallback. Tapi tandai pool null.
}

const pool = connectionString
  ? new Pool({
      connectionString,
      max: 10,                       // max koneksi dalam pool
      idleTimeoutMillis: 30000,      // 30 detik idle sebelum di-close
      connectionTimeoutMillis: 5000, // 5 detik timeout saat ambil koneksi
      options: '-c search_path=whatsapp_bot,public',
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.error('[memory/db] ❌ Unexpected error on idle PG client:', err.message);
  });
  // Daftarkan type parser pgvector pada setiap koneksi baru (per-client, OID
  // tidak shareable antar koneksi di pg < 8.x).
  pool.on('connect', (client) => {
    console.log('[memory/db] ✅ New PG client connected to schema whatsapp_bot');
    registerPgvectorTypeParser(client).catch(() => {});
  });
}

/**
 * Cek apakah database siap dipakai.
 * @returns {Promise<boolean>}
 */
async function isReady() {
  if (!pool) return false;
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  } catch (err) {
    console.error('[memory/db] Health check gagal:', err.message);
    return false;
  }
}

/**
 * Jalankan query dengan parameterized values (anti SQL injection).
 * @param {string} text SQL query
 * @param {Array} params parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  if (!pool) {
    throw new Error('[memory/db] Pool belum diinisialisasi (koneksi DB tidak ada)');
  }
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    console.warn(`[memory/db] ⚠️ Slow query (${duration}ms): ${text.substring(0, 80)}...`);
  }
  return res;
}

/**
 * Tutup pool. Panggil saat SIGINT/SIGTERM untuk graceful shutdown.
 */
async function close() {
  if (pool) {
    await pool.end();
    console.log('[memory/db] Pool closed.');
  }
}

module.exports = {
  pool,
  isReady,
  query,
  close,
};
