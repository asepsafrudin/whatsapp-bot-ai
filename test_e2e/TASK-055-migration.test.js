// =============================================================================
// Test E2E untuk TASK-055 Fase 2 Bugfix
// =============================================================================
// Tujuan: verifikasi 5 perbaikan bug yang dilakukan pada commit 20e166c.
// Prasyarat: DATABASE_URL atau POSTGRES_* env sudah di-set, dan DB bisa diakses.
// Jalankan: node test_e2e/TASK-055-migration.test.js
// =============================================================================

'use strict';

const { Pool } = require('pg');
const store = require('../memory/store.js');

const connectionString = process.env.DATABASE_URL || process.env.WHATSAPP_MEMORY_DATABASE_URL;

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { console.log('  ✅', label); pass++; }
  else { console.log('  ❌', label); fail++; }
}

async function run() {
  if (!connectionString) {
    console.error('❌ Set DATABASE_URL atau POSTGRES_* env untuk menjalankan test ini.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  console.log('--- TASK-055 Fase 2 E2E Test ---\n');

  // ---- TEST 1: detectHasVector ----
  console.log('Test 1: detectHasVector()');
  await store.detectHasVector(true);  // force refresh
  const hasVector = await store.detectHasVector();
  assert(typeof hasVector === 'boolean', 'detectHasVector returns boolean');
  console.log(`  ℹ️  hasVector=${hasVector} (pgvector ${hasVector ? 'ON' : 'OFF'})`);

  // ---- TEST 2: Migration dapat VIEW dengan/s tanpa pgvector ----
  console.log('\nTest 2: v_durable_memories view exists');
  const viewCheck = await client.query(
    `SELECT 1 FROM information_schema.views
     WHERE table_schema='whatsapp_bot' AND table_name='v_durable_memories' LIMIT 1`
  );
  assert(viewCheck.rows.length > 0, 'view v_durable_memories exists');

  if (hasVector) {
    const colCheck = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='whatsapp_bot' AND table_name='v_durable_memories'
         AND column_name='has_embedding' LIMIT 1`
    );
    assert(colCheck.rows.length > 0, 'view has has_embedding column (pgvector ON)');
  } else {
    console.log('  ℹ️  pgvector OFF, skip has_embedding check');
  }

  // ---- TEST 3: Kolom-kolom TASK-055 ada ----
  console.log('\nTest 3: TASK-055 columns exist');
  for (const col of ['embedding', 'consolidated_at', 'source_memory_ids']) {
    if (col === 'embedding' && !hasVector) {
      console.log(`  ⏭️  skip ${col} (pgvector OFF, column not created)`);
      continue;
    }
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='whatsapp_bot' AND table_name='memories' AND column_name=$1`,
      [col]
    );
    assert(r.rows.length > 0, `column ${col} exists`);
  }

  // ---- TEST 4: Insert + soft-delete + filter expires_at ----
  console.log('\nTest 4: filter expires_at excludes soft-deleted rows');
  const SCOPE = `e2e_test_${Date.now()}`;
  const TEST_ID = 9999999999;
  // Bersihkan test sebelumnya
  await client.query(`DELETE FROM whatsapp_bot.memories WHERE scope_id=$1`, [SCOPE]);

  if (hasVector) {
    // Insert 2 row durable: satu "alive", satu soft-deleted
    await store.saveDurableMemory('user', SCOPE, 'User suka nasi goreng', {
      embedding: new Array(384).fill(0).map((_, i) => Math.sin(i)),
      source: 'e2e_test',
    });
    const all = await store.listDurableMemory('user', SCOPE);
    assert(all.length === 1, `listDurableMemory returns ${all.length === 1 ? 1 : all.length} alive row`);
    const aliveId = all[0].id;

    // Soft-delete (simulasi merge loser)
    await client.query(
      `UPDATE whatsapp_bot.memories SET expires_at = NOW() WHERE id = $1`,
      [aliveId]
    );
    const after = await store.listDurableMemory('user', SCOPE);
    assert(after.length === 0, 'listDurableMemory excludes soft-deleted row');
    const found = await store.getDurableMemory(aliveId);
    assert(found === null, 'getDurableMemory returns null for soft-deleted row');
    const similar = await store.findSimilarDurable('user', SCOPE, new Array(384).fill(0).map((_, i) => Math.sin(i)), 5, 0.5);
    assert(similar.length === 0, 'findSimilarDurable excludes soft-deleted row');
  } else {
    console.log('  ⏭️  skip (pgvector OFF, requires embedding column)');
  }

  // ---- Cleanup ----
  await client.query(`DELETE FROM whatsapp_bot.memories WHERE scope_id=$1`, [SCOPE]);
  client.release();
  await pool.end();

  console.log(`\n--- Summary: ${pass} pass, ${fail} fail ---`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('Test crashed:', e);
  process.exit(1);
});
