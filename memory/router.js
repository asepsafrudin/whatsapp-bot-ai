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
  // TASK-054 (Fase 5): tambah explicit & profile memory detection.
  const lower = (text || '').toLowerCase().trim();
  const memory_types = ['recent'];
  let command = null;  // TASK-054: command intent (untuk handler di index.js)

  // === TASK-054: Command detection ===
  // !ingat <key>: <value>  → explicit memory (durable, per-user)
  // !lupa <key>           → hapus explicit memory
  // !profile <key> <value> → profile memory (preferences, durable)
  // !memory               → list semua explicit memory user
  if (lower.startsWith('!ingat ') || lower.startsWith('!remember ')) {
    memory_types.push('explicit');
    command = { type: 'save_explicit', memoryType: 'explicit' };
  } else if (lower.startsWith('!lupa ') || lower.startsWith('!forget ')) {
    command = { type: 'delete_explicit', memoryType: 'explicit' };
  } else if (lower.startsWith('!profile ')) {
    memory_types.push('profile');
    command = { type: 'save_explicit', memoryType: 'profile' };
  } else if (lower === '!memory' || lower === '!ingat' || lower === '!profile') {
    command = { type: 'list_explicit', memoryType: 'explicit' };
  } else if (lower.includes('ingat') || lower.includes('preferensi saya')) {
    // Hint natural language (untuk LLM context, bukan command langsung)
    memory_types.push('explicit');
    memory_types.push('profile');
  }

  return {
    active: true,
    scope_type,
    scope_id,
    memory_types,
    command,  // TASK-054: null jika bukan command, atau {type, memoryType}
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
