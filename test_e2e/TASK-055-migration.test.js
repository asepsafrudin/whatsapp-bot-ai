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
    await store.saveDurableMemory('personal', SCOPE, 'User suka nasi goreng', {
      embedding: new Array(384).fill(0).map((_, i) => Math.sin(i)),
      source: 'inferred',
    });
    const all = await store.listDurableMemory('personal', SCOPE);
    assert(all.length === 1, `listDurableMemory returns ${all.length === 1 ? 1 : all.length} alive row`);
    const aliveId = all[0].id;

    // Soft-delete (simulasi merge loser)
    await client.query(
      `UPDATE whatsapp_bot.memories SET expires_at = NOW() WHERE id = $1`,
      [aliveId]
    );
    const after = await store.listDurableMemory('personal', SCOPE);
    assert(after.length === 0, 'listDurableMemory excludes soft-deleted row');
    const found = await store.getDurableMemory(aliveId);
    assert(found === null, 'getDurableMemory returns null for soft-deleted row');
    const similar = await store.findSimilarDurable('personal', SCOPE, new Array(384).fill(0).map((_, i) => Math.sin(i)), 5, 0.5);
    assert(similar.length === 0, 'findSimilarDurable excludes soft-deleted row');
  } else {
    console.log('  ⏭️  skip (pgvector OFF, requires embedding column)');
  }

  // ---- TEST 5: ConsolidationJob end-to-end ----
  console.log('\nTest 5: ConsolidationJob merges similar rows');
  if (hasVector) {
    const MERGE_SCOPE = `e2e_merge_${Date.now()}`;
    // Bersihkan
    await client.query(`DELETE FROM whatsapp_bot.memories WHERE scope_id=$1`, [MERGE_SCOPE]);

    // Buat base vector acuan + 2 row dengan embedding SANGAT mirip (cosine ~1)
    const base = new Array(384).fill(0).map((_, i) => Math.sin(i * 0.1));
    const similar1 = base.map((v) => v + (Math.random() - 0.5) * 0.001);  // perturbasi kecil
    const similar2 = base.map((v) => v + (Math.random() - 0.5) * 0.001);
    const different = new Array(384).fill(0).map((_, i) => Math.cos(i * 0.1));  // beda jauh

    const id1 = (await store.saveDurableMemory('personal', MERGE_SCOPE, 'Fact 1: user works at PUU', { embedding: base, source: 'inferred' })).id;
    const id2 = (await store.saveDurableMemory('personal', MERGE_SCOPE, 'Fact 2: user is in PUU', { embedding: similar1, source: 'inferred' })).id;
    const id3 = (await store.saveDurableMemory('personal', MERGE_SCOPE, 'Fact 3: user likes nasi goreng', { embedding: different, source: 'inferred' })).id;

    console.log(`  ℹ️  inserted 3 candidates: ids=[${id1}, ${id2}, ${id3}]`);

    // Jalankan ConsolidationJob
    const stats = await store.runConsolidationJob({
      batchSize: 10,
      similarityThreshold: 0.85,
      scopeType: 'personal',
    });
    console.log(`  ℹ️  ConsolidationJob stats: ${JSON.stringify(stats)}`);

    assert(stats.scanned >= 1, `scanned >= 1 (got ${stats.scanned})`);
    assert(stats.errors === 0, `errors === 0 (got ${stats.errors})`);

    // Verifikasi: minimal 1 row di-merge (yang mirip digabung)
    const survivors = await store.listDurableMemory('personal', MERGE_SCOPE);
    assert(survivors.length <= 2, `after merge: <= 2 survivors (got ${survivors.length})`);

    // Verifikasi: row yang berbeda (Fact 3) masih ada (tidak ikut di-merge)
    const fact3 = await store.getDurableMemory(id3);
    assert(fact3 !== null, 'different row (Fact 3) still exists after ConsolidationJob');

    // Cleanup
    await client.query(`DELETE FROM whatsapp_bot.memories WHERE scope_id=$1`, [MERGE_SCOPE]);
  } else {
    console.log('  ⏭️  skip (pgvector OFF)');
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
