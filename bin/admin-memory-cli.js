#!/usr/bin/env node
// =============================================================================
// TASK-056 (Fase 6): Admin Memory CLI
// =============================================================================
// Lokasi: services/whatsapp-bot-ai/bin/admin-memory-cli.js
// Deskripsi: CLI untuk admin inspeksi & hard-delete (GDPR) memory.
// Sub-commands:
//   - search  --scope-id <JID> [--scope-type personal|group] [--memory-type recent,explicit,...] [--include-expired] [--limit N]
//   - stats   [--scope-type personal|group]
//   - delete  --scope-id <JID> [--scope-type personal|group] [--memory-type ...] --confirm
//
// Cara pakai:
//   DATABASE_URL=postgres://... node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net
//   DATABASE_URL=postgres://... node bin/admin-memory-cli.js stats
//   DATABASE_URL=postgres://... node bin/admin-memory-cli.js delete --scope-id 628xxx@s.whatsapp.net --confirm
//
// Penting: --confirm WAJIB untuk delete (mencegah accidental data loss).
// =============================================================================

'use strict';

require('dotenv').config({ path: '../../.env' });
const store = require('../memory/store.js');

// =============================================================================
// Argv parsing (tanpa dependency eksternal)
// =============================================================================
function parseArgs(argv) {
  const args = {
    command: null,
    scopeId: null,
    scopeType: 'personal',
    memoryType: null,    // comma-separated string
    includeExpired: false,
    limit: 50,
    confirm: false,
  };
  // Positional: command
  args.command = argv[2] || null;
  for (let i = 3; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--scope-id') { args.scopeId = next; i++; }
    else if (flag === '--scope-type') { args.scopeType = next; i++; }
    else if (flag === '--memory-type') { args.memoryType = next; i++; }
    else if (flag === '--include-expired') { args.includeExpired = true; }
    else if (flag === '--limit') { args.limit = parseInt(next, 10); i++; }
    else if (flag === '--confirm') { args.confirm = true; }
    else if (flag === '-h' || flag === '--help') { args.command = 'help'; }
    else { console.error(`Unknown flag: ${flag}`); process.exit(2); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node bin/admin-memory-cli.js <command> [options]

Commands:
  search   List memory untuk satu user (filter per memory_type)
  stats    Statistik global memory (count per type, growth 1d/7d/30d, top scopes)
  delete   HARD delete memory (GDPR) — WAJIB --confirm
  help     Tampilkan bantuan

Options:
  --scope-id <JID>        WhatsApp JID (e.g. 628xxx@s.whatsapp.net atau 123@g.us)
  --scope-type <TYPE>     'personal' (default) | 'group'
  --memory-type <TYPES>   Comma-separated subset (e.g. 'recent,explicit,durable')
  --include-expired       Untuk search: ikut sertakan row expires_at <= NOW()
  --limit <N>             Untuk search: max row (default 50)
  --confirm               Untuk delete: WAJIB (tanpa ini delete akan dibatalkan)

Environment:
  DATABASE_URL          PostgreSQL connection string
  POSTGRES_*            Alternatif: POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB

Examples:
  # Lihat semua memory satu user
  node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net

  # Hanya explicit + durable memory
  node bin/admin-memory-cli.js search --scope-id 628xxx@s.whatsapp.net --memory-type explicit,durable

  # Statistik global
  node bin/admin-memory-cli.js stats

  # Statistik personal chat saja
  node bin/admin-memory-cli.js stats --scope-type personal

  # Hapus semua memory satu user (GDPR) — WAJIB --confirm!
  node bin/admin-memory-cli.js delete --scope-id 628xxx@s.whatsapp.net --confirm

  # Hapus hanya explicit memory satu user
  node bin/admin-memory-cli.js delete --scope-id 628xxx@s.whatsapp.net --memory-type explicit --confirm
`);
}

// =============================================================================
// Formatter
// =============================================================================
function fmtRow(r) {
  const dt = (r.created_at instanceof Date) ? r.created_at.toISOString().substring(0, 19).replace('T', ' ') : String(r.created_at || '-');
  const content = String(r.content || '').substring(0, 60).replace(/\n/g, ' ');
  const role = r.role || '-';
  const type = r.memory_type || '-';
  const id = r.id;
  return `[${id}] ${dt}  ${type.padEnd(10)} ${role.padEnd(10)} ${content}${String(r.content || '').length > 60 ? '...' : ''}`;
}

function fmtStats(s) {
  if (!s) return '  (failed to get stats)';
  const lines = [];
  lines.push(`  total:        ${s.total}`);
  lines.push(`  by type:      ${Object.keys(s.byType).map(k => `${k}=${s.byType[k]}`).join(', ') || '(empty)'}`);
  lines.push(`  growth 1d/7d/30d: ${s.growth.last_1d} / ${s.growth.last_7d} / ${s.growth.last_30d}`);
  if (s.oldest) lines.push(`  oldest:       ${(s.oldest instanceof Date) ? s.oldest.toISOString() : s.oldest}`);
  if (s.newest) lines.push(`  newest:       ${(s.newest instanceof Date) ? s.newest.toISOString() : s.newest}`);
  if (s.top_scopes && s.top_scopes.length > 0) {
    lines.push(`  top scopes:`);
    for (const t of s.top_scopes) {
      lines.push(`    - ${t.scope_type}:${t.scope_id}  n=${t.n}  last=${(t.last_activity instanceof Date) ? t.last_activity.toISOString() : t.last_activity}`);
    }
  }
  return lines.join('\n');
}

// =============================================================================
// Commands
// =============================================================================
async function cmdSearch(args) {
  if (!args.scopeId) {
    console.error('❌ --scope-id wajib diisi untuk search');
    process.exit(2);
  }
  const memoryTypes = args.memoryType ? args.memoryType.split(',').map(s => s.trim()) : null;
  const result = await store.searchMemoriesByScope(args.scopeId, {
    scopeType: args.scopeType,
    memoryTypes,
    includeExpired: args.includeExpired,
    limit: args.limit,
  });
  console.log(`\n🔍 Search: ${args.scopeType}:${args.scopeId}${memoryTypes ? ' (filter: ' + memoryTypes.join(',') + ')' : ''}${args.includeExpired ? ' [include-expired]' : ''}`);
  console.log(`  total returned: ${result.count}`);
  console.log(`  by type: ${JSON.stringify(result.byType)}`);
  if (result.count > 0) {
    console.log(`  rows:`);
    for (const r of result.rows) {
      console.log(`  ${fmtRow(r)}`);
    }
  }
  await store.close();
}

async function cmdStats(args) {
  const result = await store.getMemoryStats({
    scopeType: args.scopeType === 'personal' || args.scopeType === 'group' ? args.scopeType : null,
  });
  console.log(`\n📊 Memory Stats${args.scopeType ? ' (scope_type=' + args.scopeType + ')' : ' (global)'}`);
  console.log(fmtStats(result));

  // TASK-057 (Fase 3): Tampilkan implicit breakdown jika ada
  if (result && result.top_scopes && result.top_scopes.length > 0) {
    console.log(`\n  📈 Implicit Memory Breakdown (per top scope):`);
    for (const t of result.top_scopes.slice(0, 3)) {  // top 3 saja
      const imps = await store.getImplicitPatterns(t.scope_id, { scopeType: t.scope_type, limit: 1 });
      if (imps.length > 0) {
        const imp = imps[0];
        const md = imp.metadata || {};
        const peakHour = md.peak_hour_utc !== undefined ? `${md.peak_hour_utc}:00 UTC` : '?';
        const count = md.interaction_count || '?';
        const topWords = (md.top_words || []).slice(0, 5).map(w => `${w.word}(${w.count})`).join(', ');
        console.log(`    - ${t.scope_type}:${t.scope_id}`);
        console.log(`      last implicit: ${count} interaksi, peak=${peakHour}, top=${topWords || 'n/a'}`);
      }
    }
  }
  await store.close();
}

async function cmdDelete(args) {
  if (!args.scopeId) {
    console.error('❌ --scope-id wajib diisi untuk delete');
    process.exit(2);
  }
  if (!args.confirm) {
    console.error('❌ Delete operation HARUS disertai --confirm (mencegah data loss)');
    console.error('   Contoh: node bin/admin-memory-cli.js delete --scope-id <JID> --confirm');
    process.exit(2);
  }
  const memoryTypes = args.memoryType ? args.memoryType.split(',').map(s => s.trim()) : null;
  console.log(`\n🗑️  GDPR DELETE: ${args.scopeType}:${args.scopeId}${memoryTypes ? ' (filter: ' + memoryTypes.join(',') + ')' : ''}`);
  console.log('   (HARD delete — data hilang permanen, tidak bisa di-undo)');
  const result = await store.deleteMemoriesByScope(args.scopeId, {
    scopeType: args.scopeType,
    memoryTypes,
  });
  console.log(`  ✅ deleted: ${result.deleted_count} rows`);
  console.log(`  by type: ${JSON.stringify(result.byType)}`);
  await store.close();
}

// =============================================================================
// Main
// =============================================================================
async function main() {
  const args = parseArgs(process.argv);
  if (!args.command || args.command === 'help' || args.command === '-h' || args.command === '--help') {
    printHelp();
    process.exit(0);
  }
  // Validasi koneksi DB dulu
  const ready = await store.isReady();
  if (!ready) {
    console.error('❌ Database tidak siap. Cek DATABASE_URL atau POSTGRES_* env.');
    process.exit(1);
  }
  try {
    if (args.command === 'search') await cmdSearch(args);
    else if (args.command === 'stats') await cmdStats(args);
    else if (args.command === 'delete') await cmdDelete(args);
    else {
      console.error(`❌ Unknown command: ${args.command}`);
      printHelp();
      process.exit(2);
    }
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

// isReady & close harus di-export, mari pastikan ada (lihat store.js)
main();
