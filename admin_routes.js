// =============================================================================
// TASK-056 (Fase 6): Admin Web UI Routes
// =============================================================================
// Lokasi: services/whatsapp-bot-ai/admin_routes.js
// Deskripsi: Express routes /admin/* untuk admin inspeksi & hard-delete (GDPR).
//
// Endpoints:
//   GET  /admin/              — Dashboard (link ke search & stats)
//   GET  /admin/search        — Form search + hasil list memory per user
//   POST /admin/search        — Eksekusi search
//   GET  /admin/stats         — Statistik global
//   GET  /admin/delete        — Form konfirmasi delete (WAJIB ketik ulang scope_id)
//   POST /admin/delete        — Eksekusi hard-delete
//
// Auth: ADMIN_TOKEN via header `X-Admin-Token` (default juga fallback ke
//       `?token=...` query param untuk browser).
// Bind: server harus di-bind ke 127.0.0.1 saja (lihat index.js).
// =============================================================================

'use strict';

const express = require('express');
const store = require('./memory/store.js');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.MCP_ADMIN_TOKEN || null;

if (!ADMIN_TOKEN) {
  console.warn('[admin_routes] ⚠️  ADMIN_TOKEN tidak di-set! Admin UI tidak akan bisa diakses.');
}

const router = express.Router();

// Middleware: verifikasi token
function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).send(htmlError(503, 'Admin UI belum dikonfigurasi',
      'ADMIN_TOKEN env var tidak di-set. Set di .env: ADMIN_TOKEN=<random-hex-string>'));
  }
  const headerToken = req.get('X-Admin-Token');
  const queryToken = req.query.token;
  const provided = headerToken || queryToken;
  if (provided !== ADMIN_TOKEN) {
    res.set('WWW-Authenticate', 'Bearer realm="admin"');
    return res.status(401).send(htmlError(401, 'Unauthorized',
      'Butuh ADMIN_TOKEN yang valid. Kirim via header <code>X-Admin-Token</code> atau query <code>?token=...</code>'));
  }
  next();
}

// Helper: escape HTML
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&', '<': '<', '>': '>', '"': '"', "'": '&#39;',
  }[c]));
}

// Helper: error page
function htmlError(code, title, msg) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${code} ${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:50px auto;padding:20px;}
h1{color:#c00;}.box{background:#fee;padding:15px;border-radius:8px;border:1px solid #fcc;}</style>
</head><body><h1>${code} — ${esc(title)}</h1>
<div class="box"><p>${msg}</p></div>
<p><a href="javascript:history.back()">← Back</a></p>
</body></html>`;
}

// =============================================================================
// Dashboard
// =============================================================================
router.get('/', requireAdminToken, (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Admin — Memory Dashboard</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;}
h1{border-bottom:2px solid #333;padding-bottom:8px;}
ul{list-style:none;padding:0;}
li{margin:12px 0;padding:12px;background:#f4f4f4;border-radius:6px;}
a{color:#06c;text-decoration:none;font-weight:600;}
a:hover{text-decoration:underline;}
.tag{background:#333;color:#fff;padding:2px 6px;border-radius:4px;font-size:12px;margin-left:8px;}
</style></head><body>
<h1>🛠️ Admin — Memory Dashboard</h1>
<ul>
  <li><a href="/admin/search">🔍 Search memory per user</a><span class="tag">GET / POST</span></li>
  <li><a href="/admin/stats">📊 Stats & growth</a><span class="tag">GET</span></li>
  <li><a href="/admin/delete">🗑️ Delete memory (GDPR)</a><span class="tag">WAJIB konfirmasi</span></li>
</ul>
<p style="margin-top:30px;font-size:12px;color:#666;">
  Memory AI Agent — Fase 6 (TASK-056). API:
  <code>searchMemoriesByScope</code>, <code>getMemoryStats</code>, <code>deleteMemoriesByScope</code>.
</p>
</body></html>`);
});

// =============================================================================
// Search
// =============================================================================
router.get('/search', requireAdminToken, (req, res) => {
  res.send(searchFormHTML(null, null, null));
});

router.post('/search', requireAdminToken, async (req, res) => {
  const { scope_id, scope_type, memory_type, include_expired, limit } = req.body || {};
  if (!scope_id) {
    return res.status(400).send(searchFormHTML(null, null, '❌ --scope-id wajib diisi'));
  }
  const opts = {
    scopeType: scope_type || 'personal',
    memoryTypes: memory_type ? memory_type.split(',').map(s => s.trim()) : null,
    includeExpired: include_expired === 'on' || include_expired === 'true',
    limit: parseInt(limit, 10) || 50,
  };
  try {
    const result = await store.searchMemoriesByScope(scope_id, opts);
    res.send(searchFormHTML(scope_id, opts, null, result));
  } catch (e) {
    res.status(500).send(searchFormHTML(scope_id, opts, `❌ ${esc(e.message)}`));
  }
});

function searchFormHTML(scopeId, opts, errorMsg, result) {
  const tokenQS = `?token=${encodeURIComponent(ADMIN_TOKEN || '')}`;
  const rowsHTML = result && result.rows ? result.rows.map(r => `
    <tr>
      <td>${r.id}</td>
      <td>${esc((r.created_at instanceof Date) ? r.created_at.toISOString() : r.created_at)}</td>
      <td><b>${esc(r.memory_type)}</b></td>
      <td>${esc(r.role || '-')}</td>
      <td>${esc(String(r.content || '').substring(0, 200))}</td>
      <td>${esc(r.confidence_score || '-')}</td>
      <td>${esc(r.version || '-')}</td>
    </tr>`).join('') : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Search Memory</title>
<style>body{font-family:system-ui,sans-serif;max-width:1200px;margin:30px auto;padding:0 20px;}
h1{border-bottom:2px solid #333;padding-bottom:8px;}
form{background:#f4f4f4;padding:15px;border-radius:8px;margin:15px 0;}
label{display:inline-block;min-width:120px;font-weight:600;}
input,select{padding:5px;margin:2px 8px 2px 0;}
button{padding:6px 16px;background:#06c;color:#fff;border:none;border-radius:4px;cursor:pointer;}
button:hover{background:#048;}
table{width:100%;border-collapse:collapse;margin-top:15px;font-size:13px;}
th,td{padding:6px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top;}
th{background:#f0f0f0;}
tr:hover{background:#fafafa;}
.back{font-size:13px;}
.err{background:#fee;border:1px solid #fcc;padding:10px;border-radius:6px;color:#c00;}
.ok{background:#e8f5e8;border:1px solid #cfc;padding:10px;border-radius:6px;}
</style></head><body>
<p class="back"><a href="/admin/${tokenQS}">← Dashboard</a></p>
<h1>🔍 Search Memory per User</h1>
<form method="POST" action="/admin/search${tokenQS}">
  <div><label>Scope ID (JID):</label><input name="scope_id" size="50" value="${esc(scopeId || '')}" placeholder="628xxx@s.whatsapp.net" required></div>
  <div><label>Scope Type:</label>
    <select name="scope_type">
      <option value="personal" ${opts && opts.scopeType === 'personal' ? 'selected' : ''}>personal</option>
      <option value="group" ${opts && opts.scopeType === 'group' ? 'selected' : ''}>group</option>
    </select>
  </div>
  <div><label>Memory Type:</label><input name="memory_type" size="30" value="${esc(opts && opts.memoryTypes ? opts.memoryTypes.join(',') : '')}" placeholder="(kosong = semua, atau: recent,explicit,durable)"></div>
  <div><label>Include Expired:</label><input type="checkbox" name="include_expired" ${opts && opts.includeExpired ? 'checked' : ''}></div>
  <div><label>Limit:</label><input name="limit" size="5" value="${esc(opts && opts.limit || 50)}"></div>
  <div style="margin-top:10px;"><button type="submit">🔍 Search</button></div>
</form>
${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}
${result ? `
  <div class="ok">
    <b>${result.count}</b> row dikembalikan (by type: ${esc(JSON.stringify(result.byType))})
  </div>
  ${rowsHTML ? `<table>
    <tr><th>ID</th><th>Created</th><th>Type</th><th>Role</th><th>Content (truncated)</th><th>Conf</th><th>Ver</th></tr>
    ${rowsHTML}
  </table>` : '<p><i>Tidak ada row.</i></p>'}
` : ''}
</body></html>`;
}

// =============================================================================
// Stats
// =============================================================================
router.get('/stats', requireAdminToken, async (req, res) => {
  try {
    const stats = await store.getMemoryStats();
    const tokenQS = `?token=${encodeURIComponent(ADMIN_TOKEN || '')}`;
    const topRows = stats.top_scopes.map(t => `<tr>
      <td>${esc(t.scope_type)}</td>
      <td>${esc(t.scope_id)}</td>
      <td>${t.n}</td>
      <td>${esc((t.last_activity instanceof Date) ? t.last_activity.toISOString() : t.last_activity)}</td>
    </tr>`).join('');
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Memory Stats</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:30px auto;padding:0 20px;}
h1{border-bottom:2px solid #333;padding-bottom:8px;}
table{border-collapse:collapse;margin:10px 0;width:100%;font-size:14px;}
th,td{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;}
th{background:#f0f0f0;}
.box{background:#f4f4f4;padding:15px;border-radius:6px;margin:10px 0;}
.kv{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0;}
.kv div{background:#fff;padding:10px 15px;border-radius:6px;flex:1;min-width:140px;border:1px solid #ddd;}
.kv div b{display:block;font-size:20px;color:#06c;}
.back{font-size:13px;}
</style></head><body>
<p class="back"><a href="/admin/${tokenQS}">← Dashboard</a></p>
<h1>📊 Memory Stats</h1>
<div class="kv">
  <div>Total<b>${stats.total}</b></div>
  <div>Last 1 day<b>${stats.growth.last_1d}</b></div>
  <div>Last 7 days<b>${stats.growth.last_7d}</b></div>
  <div>Last 30 days<b>${stats.growth.last_30d}</b></div>
</div>
<div class="box"><b>By type:</b> ${esc(JSON.stringify(stats.byType))}</div>
<div class="box"><b>Oldest:</b> ${esc((stats.oldest instanceof Date) ? stats.oldest.toISOString() : stats.oldest)}<br>
<b>Newest:</b> ${esc((stats.newest instanceof Date) ? stats.newest.toISOString() : stats.newest)}</div>
<h2>Top 10 Scopes</h2>
<table>
  <tr><th>Type</th><th>Scope ID</th><th>Rows</th><th>Last Activity</th></tr>
  ${topRows}
</table>
<p style="margin-top:20px;font-size:11px;color:#666;">Generated at: ${esc(stats.generated_at)}</p>
</body></html>`);
  } catch (e) {
    res.status(500).send(htmlError(500, 'Stats error', esc(e.message)));
  }
});

// =============================================================================
// Delete (GDPR) — WAJIB ketik ulang scope_id untuk konfirmasi
// =============================================================================
router.get('/delete', requireAdminToken, (req, res) => {
  res.send(deleteFormHTML(null, null, null));
});

router.post('/delete', requireAdminToken, async (req, res) => {
  const { scope_id, scope_id_confirm, scope_type, memory_type } = req.body || {};
  if (!scope_id || !scope_id_confirm) {
    return res.status(400).send(deleteFormHTML(scope_id, scope_id_confirm, '❌ Scope ID & konfirmasi wajib diisi'));
  }
  if (scope_id !== scope_id_confirm) {
    return res.status(400).send(deleteFormHTML(scope_id, scope_id_confirm, '❌ Scope ID tidak cocok dengan konfirmasi. Hapus dibatalkan.'));
  }
  const opts = {
    scopeType: scope_type || 'personal',
    memoryTypes: memory_type ? memory_type.split(',').map(s => s.trim()) : null,
  };
  try {
    const result = await store.deleteMemoriesByScope(scope_id, opts);
    res.send(deleteResultHTML(scope_id, opts, result));
  } catch (e) {
    res.status(500).send(deleteFormHTML(scope_id, scope_id_confirm, `❌ ${esc(e.message)}`));
  }
});

function deleteFormHTML(scopeId, confirmVal, errorMsg) {
  const tokenQS = `?token=${encodeURIComponent(ADMIN_TOKEN || '')}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Delete Memory (GDPR)</title>
<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:30px auto;padding:0 20px;}
h1{border-bottom:2px solid #c00;padding-bottom:8px;color:#c00;}
form{background:#fee;padding:20px;border-radius:8px;border:1px solid #fcc;}
label{display:block;font-weight:600;margin-top:10px;}
input,select{padding:8px;width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;font-family:monospace;}
button{padding:10px 24px;background:#c00;color:#fff;border:none;border-radius:4px;cursor:pointer;margin-top:15px;font-size:14px;}
button:hover{background:#a00;}
.warn{background:#fff3cd;border:1px solid #ffc;padding:10px;border-radius:6px;color:#856404;margin:15px 0;}
.err{background:#fdd;border:1px solid #fcc;padding:10px;border-radius:6px;color:#c00;margin:10px 0;}
.back{font-size:13px;}
</style></head><body>
<p class="back"><a href="/admin/${tokenQS}">← Dashboard</a></p>
<h1>🗑️ Delete Memory (GDPR)</h1>
<div class="warn">⚠️ <b>PERHATIAN</b>: Operasi ini melakukan <b>HARD DELETE</b> — data hilang permanen dan tidak bisa di-undo.
Gunakan hanya untuk compliance GDPR atau penghapusan data user yang diminta.</div>
${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}
<form method="POST" action="/admin/delete${tokenQS}">
  <label>Scope ID (JID) — yang akan dihapus:</label>
  <input name="scope_id" value="${esc(scopeId || '')}" placeholder="628xxx@s.whatsapp.net" required>
  <label>Scope Type:</label>
  <select name="scope_type">
    <option value="personal">personal</option>
    <option value="group">group</option>
  </select>
  <label>Memory Type (filter, kosong = semua):</label>
  <input name="memory_type" placeholder="(kosong = semua, atau: recent,explicit,durable)">
  <label>Konfirmasi: ketik ulang Scope ID persis sama:</label>
  <input name="scope_id_confirm" value="${esc(confirmVal || '')}" placeholder="Ketik ulang persis sama" required>
  <div style="margin-top:15px;"><button type="submit">🗑️ HARD DELETE</button></div>
</form>
<p class="back" style="margin-top:20px;font-size:12px;"><a href="/admin/${tokenQS}">← Dashboard</a></p>
</body></html>`;
}

function deleteResultHTML(scopeId, opts, result) {
  const tokenQS = `?token=${encodeURIComponent(ADMIN_TOKEN || '')}`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Delete Result</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:30px auto;padding:0 20px;}
.ok{background:#fee;border:1px solid #fcc;padding:20px;border-radius:6px;color:#c00;margin:15px 0;}
.back{font-size:13px;}
</style></head><body>
<p class="back"><a href="/admin/${tokenQS}">← Dashboard</a></p>
<h1>🗑️ Delete Result</h1>
<div class="ok">
  <p><b>HARD DELETE selesai</b> untuk <code>${esc(opts.scopeType)}:${esc(scopeId)}</code></p>
  <p><b>${result.deleted_count}</b> row dihapus (by type: ${esc(JSON.stringify(result.byType))})</p>
  <p style="margin-top:15px;font-size:13px;">⚠️ Data sudah hilang permanen dari database. Tidak bisa di-undo.</p>
</div>
<p><a href="/admin/delete${tokenQS}">← Hapus user lain</a> | <a href="/admin/${tokenQS}">Dashboard</a></p>
</body></html>`;
}

module.exports = router;
