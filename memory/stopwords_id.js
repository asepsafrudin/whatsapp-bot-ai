// =============================================================================
// TASK-057 (Fase 3): Stopwords Bahasa Indonesia
// =============================================================================
// Lokasi: services/whatsapp-bot-ai/memory/stopwords_id.js
// Deskripsi: List stopword (kata umum) bahasa Indonesia untuk word frequency
//           di aggregateImplicitPatterns(). Tanpa filter ini, top-10 topik
//           akan didominasi "yang/dan/itu/di/ke" — bukan topik bermakna.
//
// Total: ~30 stopword. Tambahkan sesuai kebutuhan (terutama untuk bahasa
// percakapan WhatsApp: "sih", "deh", "dong", "kok" — sudah termasuk).
//
// Bukan berusaha komprehensif seperti NLTK/Stopword-ID (ITB). Ini cukup
// untuk v1 — eliminasi paling jelas saja.
//
// Catatan: tidak include "tidak/bukan" karena bisa pembeda sentimen.
// =============================================================================

'use strict';

const STOPWORDS_ID = new Set([
  // Kata penghubung & preposisi
  'yang', 'dan', 'itu', 'di', 'ke', 'dari', 'untuk', 'dengan', 'pada',
  'dalam', 'oleh', 'akan', 'pada', 'bagi', 'pada', 'antara',

  // Kata umum (filler)
  'adalah', 'ada', 'ini', 'itu', 'juga', 'sudah', 'belum', 'sedang',
  'masih', 'telah', 'pernah', 'selalu', 'sering', 'kadang',

  // Kata negasi (kecuali "tidak" — terlalu penting)
  'jangan', 'tanpa',

  // Kata tanya
  'apa', 'siapa', 'kapan', 'dimana', 'mengapa', 'kenapa', 'bagaimana',
  'gimana',

  // Kata ganti
  'saya', 'aku', 'kamu', 'kamu', 'dia', 'mereka', 'kita', 'kami',
  'kalian', 'mereka', 'nya', 'ku', 'mu',

  // Demonstratif
  'ini', 'itu', 'sini', 'situ', 'sana',

  // Konjungsi
  'atau', 'dan', 'tetapi', 'namun', 'sedangkan', 'sementara', 'jika',
  'kalau', 'saat', 'ketika', 'karena', 'sebab', 'akibat', 'sehingga',
  'supaya', 'agar',

  // Filler percakapan WhatsApp
  'sih', 'deh', 'dong', 'kok', 'kayak', 'gitu', 'aja', 'banget',
  'kok', 'sih', 'tuh',

  // Bilangan/partikel umum
  'semua', 'banyak', 'sedikit', 'beberapa', 'satu', 'dua', 'tiga',

  // Lain-lain
  'oke', 'ok', 'ya', 'gak', 'ga', 'enggak', 'ngga', 'nggak', 'ngga',
  'sih', 'aja', 'doang', 'aja', 'biar', 'supaya', 'biar',
]);

/**
 * Cek apakah sebuah kata adalah stopword bahasa Indonesia.
 * @param {string} word — kata lowercased (caller responsibility)
 * @returns {boolean}
 */
function isStopwordId(word) {
  return STOPWORDS_ID.has(word);
}

/**
 * Filter array kata-kata (lowercased) — return hanya yang BUKAN stopword.
 * Juga filter kata < minLength (default 3) untuk eliminasi noise tambahan.
 *
 * @param {string[]} words
 * @param {number} [minLength=3]
 * @returns {string[]}
 */
function filterStopwords(words, minLength = 3) {
  return words.filter((w) => w.length >= minLength && !STOPWORDS_ID.has(w));
}

module.exports = {
  STOPWORDS_ID,
  isStopwordId,
  filterStopwords,
};
