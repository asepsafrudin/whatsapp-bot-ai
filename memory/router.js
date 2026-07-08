// ==============================================================================
// memory/router.js — Memory Router (Fase 1b: personal + group)
// ==============================================================================
// Lokasi: services/whatsapp-bot-ai/memory/router.js
// Deskripsi: Tentukan memori mana saja yang relevan untuk suatu pesan.
//            Fase 1a: personal chat only.
//            Fase 1b: personal + group chat (keduanya pakai recent memory).
//            Fase 2+: tambah profile/explicit/durable/implicit berdasarkan
//            keyword/intent sederhana.
//
// Referensi: docs/09-proposals/Diagram_Memori_AI_Agent_Revisi.md § Read Path
// ==============================================================================

'use strict';

/**
 * Tentukan scope_type untuk pesan masuk.
 * @param {boolean} isGroup
 * @returns {'personal' | 'group'}
 */
function resolveScopeType(isGroup) {
  return isGroup ? 'group' : 'personal';
}

/**
 * Tentukan scope_id untuk pesan masuk.
 * Personal: JID lawan bicara (remoteJid).
 * Group: group JID (remoteJid, diakhiri @g.us).
 *
 * @param {string} remoteJid
 * @param {boolean} isGroup
 * @returns {{scope_type: string, scope_id: string}}
 */
function resolveScope(remoteJid, isGroup) {
  return {
    scope_type: resolveScopeType(isGroup),
    scope_id: remoteJid,
  };
}

/**
 * Selector memori. Untuk Fase 1b: personal DAN group chat → recent memory aktif.
 *
 * @param {object} ctx
 * @param {string} ctx.remoteJid
 * @param {boolean} ctx.isGroup
 * @param {string} ctx.text  isi pesan
 * @returns {{
 *   active: boolean,
 *   scope_type: 'personal'|'group',
 *   scope_id: string,
 *   memory_types: Array<'recent'|'profile'|'explicit'|'durable'|'implicit'>,
 *   reason: string
 * }}
 */
function selectMemoryStores(ctx) {
  const { isGroup, remoteJid, text } = ctx;
  const { scope_type, scope_id } = resolveScope(remoteJid, isGroup);

  // Fase 1b: baik personal maupun group, recent memory AKTIF.
  // (Fase 2+ akan tambah: profile, explicit jika "ingat", durable jika keyword)
  const lower = (text || '').toLowerCase();
  const memory_types = ['recent'];

  // Hint untuk fase berikutnya (saat ini hanya dicatat di metadata, belum di-eksekusi)
  if (lower.includes('ingat') || lower.startsWith('!remember')) {
    memory_types.push('explicit'); // planned Fase 2
  }
  if (lower.startsWith('!profile') || lower.includes('preferensi saya')) {
    memory_types.push('profile'); // planned Fase 2
  }

  return {
    active: true,
    scope_type,
    scope_id,
    memory_types,
    reason: isGroup
      ? 'Fase 1b: group chat → recent memory only.'
      : 'Fase 1b: personal chat → recent memory only.',
  };
}

/**
 * Ambil history untuk scope tertentu. Convenience wrapper.
 * @param {string} scopeType
 * @param {string} scopeId
 * @param {number} [limit=10]
 */
async function loadHistory(scopeType, scopeId, limit) {
  const store = require('./store');
  return store.getRecentTurns(scopeType, scopeId, limit);
}

module.exports = {
  resolveScopeType,
  resolveScope,
  selectMemoryStores,
  loadHistory,
};
