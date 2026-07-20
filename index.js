require('dotenv').config({ path: '../../.env' });
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const crypto = require('crypto');  // TASK-050: untuk requestId
const briefing = require('./briefing');
// TASK-047 Fase 1a: Modul memori (PostgreSQL-backed)
const memoryStore = require('./memory/store');
const memoryRouter = require('./memory/router');
const memoryDb = require('./memory/db');
// TASK-108 (review follow-up, opsi A): konfigurasi grup briefing dari DB
const groupConfig = require('./memory/group_config');
const { formatToWhatsApp } = require('./formatter');
const sendQueue = require('./send_queue');

// Konfigurasi API
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001/api/v1/chat';
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'http://localhost:3001';

// Helper: baca WEBHOOK_SECRET dengan fallback MCP_WEBHOOK_SECRET (TASK-051)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || process.env.MCP_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  // PATCH STABILITAS P1: FAIL-FAST. Sebelumnya bot tetap berjalan tanpa secret,
  // sehingga SEMUA request ditolak 403 dua arah (bot↔orchestrator) — gejalanya
  // persis "bot tidak stabil", padahal miskonfigurasi. Lebih baik exit dan
  // biarkan systemd merestart dengan log yang jelas.
  console.error('[Init] ❌ FATAL: WEBHOOK_SECRET / MCP_WEBHOOK_SECRET tidak diset di env.');
  console.error('[Init] Cek /home/aseps/MCP/config/env/.env.core atau .env.messaging');
  console.error('[Init] Bot berhenti agar tidak berjalan dalam keadaan selalu gagal auth.');
  process.exit(1);
}

// Inisialisasi Express Webhook Server
const app = express();
// Body parsers — PENTING: express.urlencoded WAJIB didaftarkan SEBELUM
// route yang membaca req.body (lihat admin_routes.js). Tanpa ini,
// form submit di /admin/search dan /admin/delete akan gagal (req.body undefined).
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =============================================================================
// TASK-056 (Fase 6): Hardening bind admin UI ke 127.0.0.1 saja.
// =============================================================================
// Webhook server dipakai untuk 2 hal:
//   1) WhatsApp webhook dari orchestrator (/webhook/whatsapp, /memory/save_durable, dll)
//      → WAJIB reachable dari orchestrator (bisa di host berbeda, jadi 0.0.0.0 OK)
//   2) Admin UI (/admin/*) → WAJIB localhost-only (keamanan)
//
// Solusi: kita listen ke 127.0.0.1 jika WEBHOOK_BIND_ADMIN_LOCALHOST=true
// (default true). Untuk production multi-host, set env ke false & pakai
// reverse proxy (Caddy/nginx) untuk expose webhook ke public tapi block /admin/*.
// =============================================================================
const BIND_ADMIN_LOCALHOST = process.env.WEBHOOK_BIND_ADMIN_LOCALHOST !== 'false';
if (BIND_ADMIN_LOCALHOST) {
  console.log('[Init] ⚠️  Webhook server akan bind ke 127.0.0.1 (admin UI aman, webhook only reachable dari local)');
} else {
  console.warn('[Init] ⚠️  WEBHOOK_BIND_ADMIN_LOCALHOST=false — server bind ke 0.0.0.0!');
  console.warn('[Init]    Pastikan /admin/* di-block dari public via reverse proxy!');
}

// =============================================================================
// TASK-053: Real-time contacts.upsert hook → public.member_profiles
// =============================================================================
// Fire-and-forget: tidak mengganggu flow chat. Error di-log tapi tidak throw.
// Source: 'whatsapp_realtime'. Segment default 'default' (akan di-reclassify
// oleh contacts_sync_v2.py mingguan jika ada di Google Contacts).
// =============================================================================
async function upsertContactToDb(contact) {
  if (!contact || !contact.id) return false;
  if (!memoryDb || !memoryDb.pool) {
    console.warn('[Contacts] DB pool tidak tersedia, skip upsert untuk', contact.id);
    return false;
  }
  try {
    const jid = contact.id;
    const name = contact.name || contact.notify || contact.verifiedName || 'Unknown';
    // Extract phone dari JID: format 6281234567890@s.whatsapp.net
    const phone = (jid.includes('@s.whatsapp.net') || jid.includes('@lid'))
      ? jid.split('@')[0].replace(/\D/g, '')
      : null;
    const metadata = {
      push_name: contact.notify || null,
      verified_name: contact.verifiedName || null,
      img_url: contact.imgUrl || null,
      status: contact.status || null,
      raw: contact,
    };
    const sql = `
      INSERT INTO public.member_profiles
        (whatsapp_id, name, role, segment, source, phone, metadata, last_synced_at, updated_at)
      VALUES
        ($1, $2, 'default', 'default', 'whatsapp_realtime', $3, $4::jsonb, NOW(), NOW())
      ON CONFLICT (whatsapp_id) DO UPDATE SET
        name           = COALESCE(EXCLUDED.name, public.member_profiles.name),
        source         = CASE
          WHEN public.member_profiles.source IN ('google', 'manual') THEN public.member_profiles.source
          ELSE 'whatsapp_realtime'
        END,
        phone          = COALESCE(EXCLUDED.phone, public.member_profiles.phone),
        metadata       = EXCLUDED.metadata,
        last_synced_at = NOW(),
        updated_at     = NOW()
      RETURNING (xmax = 0) AS is_insert
    `;
    const res = await memoryDb.query(sql, [jid, name, phone, JSON.stringify(metadata)]);
    const isInsert = res.rows[0]?.is_insert === true;
    console.log(`[Contacts] ✅ contact upserted (${isInsert ? 'INSERT' : 'UPDATE'}): ${jid} → ${name}`);
    return true;
  } catch (err) {
    // Jangan throw — hanya log. contacts_sync_v2.py mingguan akan backfill.
    console.warn(`[Contacts] ⚠️ Gagal upsert ${contact.id} ke DB: ${err.message}`);
    return false;
  }
}

let waContacts = {};
const fs = require('fs');

// Load kontak dari file jika ada
try {
  if (fs.existsSync('./wa_contacts.json')) {
    waContacts = JSON.parse(fs.readFileSync('./wa_contacts.json', 'utf8'));
  }
} catch (e) {
  console.error("Gagal load wa_contacts.json");
}

let sock;
let cronBriefingJobs = [];
let cronPurge, cronConsolidasi, cronImplicit, cronImplicitPurge;

// REVIEW-FIX TASK-107: socket di-resolve lazy oleh queue — pesan yang di-enqueue
// sebelum reconnect tetap dikirim memakai socket terbaru.
sendQueue.setSockProvider(() => sock);

// =============================================================================
// PATCH STABILITAS P1 (2026-07-19)
// =============================================================================
// (a) WATCHDOG balasan orchestrator: setelah ack "⏳ Sedang memproses..." terkirim,
//     jika webhook balasan tidak datang dalam RESPONSE_WATCHDOG_MS, user diberi
//     tahu (tidak ada lagi ack yang menggantung selamanya).
// (b) DEDUP pesan: WhatsApp mengirim ulang pesan yang belum ter-ack setelah
//     reconnect. Tanpa dedup, pesan diproses ulang → user menerima balasan dobel.
// (c) RECONNECT GUARD: mencegah startBot() tumpang-tindih saat event 'close'
//     terpanggil berulang (515 restartRequired, stream error, dll).
// =============================================================================
const RESPONSE_WATCHDOG_MS = parseInt(process.env.RESPONSE_WATCHDOG_MS || '60000', 10);
const pendingRequests = new Map(); // requestId -> { remoteJid, timer }

function armResponseWatchdog(requestId, remoteJid, quotedMsg) {
  const timer = setTimeout(async () => {
    if (pendingRequests.delete(requestId)) {
      console.warn(`[Watchdog] ⏱️ Timeout ${RESPONSE_WATCHDOG_MS}ms menunggu balasan orchestrator (request_id=${requestId})`);
      try {
        await sendQueue.enqueueMessage(sock, remoteJid, {
          text: '⚠️ Respons AI terlalu lama. Kemungkinan server sedang sibuk — silakan coba lagi.',
        }, { quoted: quotedMsg });
      } catch (e) {
        console.warn('[Watchdog] Gagal kirim pesan timeout:', e.message);
      }
    }
  }, RESPONSE_WATCHDOG_MS);
  pendingRequests.set(requestId, { remoteJid, timer });
}

function disarmResponseWatchdog(requestId) {
  const pend = pendingRequests.get(requestId);
  if (pend) {
    clearTimeout(pend.timer);
    pendingRequests.delete(requestId);
    return true;
  }
  return false;
}

const PROCESSED_MAX = 2000;
const processedMsgIds = new Set();
/** Return true jika pesan SUDAH pernah diproses (duplikat → harus di-skip). */
function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.add(msgId);
  // Prune FIFO sederhana agar Set tidak tumbuh tanpa batas
  if (processedMsgIds.size > PROCESSED_MAX) {
    const oldest = processedMsgIds.values().next().value;
    processedMsgIds.delete(oldest);
  }
  return false;
}

// REVIEW-FIX TASK-107 (B): idempotensi webhook — retry orchestrator (PATCH P1,
// WEBHOOK_MAX_RETRY=3) untuk request_id yang sama TIDAK mengirim ulang balasan
// ke user. Sebelumnya dedup hanya ada di lapisan memori, bukan pengiriman.
const WEBHOOK_ID_TTL_MS = 10 * 60 * 1000;
const recentWebhookIds = new Map(); // request_id -> timestamp (ms)
function isDuplicateWebhook(requestId) {
  if (!requestId) return false;
  const now = Date.now();
  for (const [id, ts] of recentWebhookIds) {
    if (now - ts > WEBHOOK_ID_TTL_MS) recentWebhookIds.delete(id);
  }
  if (recentWebhookIds.has(requestId)) return true;
  recentWebhookIds.set(requestId, now);
  return false;
}

let startBotInFlight = false;
let reconnectTimer = null;
function scheduleReconnect(delayMs) {
  if (reconnectTimer) return; // sudah ada jadwal — abaikan pemicu berulang
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBotGuarded().catch(err => console.error('[Reconnect] startBot gagal:', err.message));
  }, delayMs);
}

// Wrapper startBot dengan guard: mencegah 2+ socket Baileys tumpang-tindih
// (penyebab balasan dobel & event handler ganda).
async function startBotGuarded() {
  if (startBotInFlight) {
    console.log('[Reconnect] startBot sedang berjalan, abaikan pemanggilan ganda.');
    return;
  }
  startBotInFlight = true;
  try {
    await startBot();
  } finally {
    startBotInFlight = false;
  }
}
// =============================================================================

// =============================================================================
// TASK-056 (Fase 6): Mount admin Web UI routes
// =============================================================================
// Endpoint: /admin/* (search, stats, delete) — dilindungi ADMIN_TOKEN.
// Server HARUS di-bind ke 127.0.0.1 saja (lihat app.listen di bawah).
// =============================================================================
try {
  const adminRouter = require('./admin_routes.js');
  app.use('/admin', adminRouter);
  console.log('[Init] ✅ Admin Web UI mounted at /admin/* (auth: ADMIN_TOKEN)');
} catch (e) {
  console.error('[Init] ❌ Gagal load admin_routes.js:', e.message);
}

// Endpoint untuk menarik daftar kontak WA
app.get('/api/contacts', (req, res) => {
  try {
    res.status(200).json(waContacts);
  } catch (err) {
    console.error("[API Error] Gagal membaca contacts:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint untuk menerima balasan dari FastAPI (LangGraph Orchestrator)
// =============================================================================
// TASK-055 (Fase 2): Endpoint /memory/save_durable — dipanggil orchestrator
// setelah extract_facts_from_history() di /api/v1/memory/extract.
// =============================================================================
app.post('/memory/save_durable', async (req, res) => {
  // Webhook secret check (shared dengan orchestrator)
  const provided = req.headers['x-webhook-secret'] || req.headers['X-Webhook-Secret'];
  if (provided !== process.env.WEBHOOK_SECRET && provided !== process.env.MCP_WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Akses Ditolak: Webhook Secret Tidak Valid' });
  }
  const {
    scope_type, scope_id, content, embedding,
    source_memory_ids, metadata,
  } = req.body || {};
  if (!scope_type || !scope_id || !content || !embedding) {
    return res.status(400).json({ error: 'scope_type, scope_id, content, embedding wajib diisi' });
  }
  try {
    const result = await memoryStore.saveDurableMemory(scope_type, scope_id, content, {
      embedding,
      source: 'inferred',  // hasil extract LLM
      role: 'system',
      confidenceScore: (metadata && metadata.extraction_confidence) || 0.7,
      metadata: metadata || {},
      sourceMemoryIds: source_memory_ids || null,
    });
    console.log(`[Memory] 💎 Saved durable memory id=${result.id} for ${scope_type}:${scope_id}`);
    return res.json({ status: 'ok', ...result });
  } catch (e) {
    console.error('[Memory] ❌ /memory/save_durable error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const webhookSecret = req.headers['x-webhook-secret'];
    if (webhookSecret !== WEBHOOK_SECRET) {
      console.error("[Webhook Error]: Akses ditolak. Secret tidak valid.");
      return res.status(403).json({ error: "Forbidden: Invalid Webhook Secret" });
    }

    const { user_id, response, request_id, sender_id } = req.body;  // TASK-050: terima request_id
    console.log(`[Webhook] Menerima balasan untuk: ${user_id} (request_id=${request_id || 'none'})`);

    // PATCH STABILITAS P1: balasan dari orchestrator diterima → matikan watchdog
    if (request_id) disarmResponseWatchdog(request_id);

    if (sock && user_id && response) {
      // REVIEW-FIX TASK-107 (B): dedup pengiriman by request_id — retry
      // orchestrator tidak boleh mengirim balasan yang sama dua kali ke user.
      if (isDuplicateWebhook(request_id)) {
        console.log(`[Webhook] ⏭️ request_id=${request_id} sudah diproses, skip kirim (dedup).`);
        return res.status(200).json({ success: true, deduplicated: true });
      }

      // Format respon agar kompatibel dan maksimal di WhatsApp
      const formattedResponse = formatToWhatsApp(response);

      const sendOptions = {};
      let finalResponse = formattedResponse;
      if (typeof user_id === 'string' && user_id.endsWith('@g.us') && sender_id) {
        sendOptions.mentions = [sender_id];
        const senderPhone = sender_id.split('@')[0];
        finalResponse = `@${senderPhone}\n\n${formattedResponse}`;
      }
      sendOptions.text = finalResponse;

      // REVIEW-FIX TASK-107 (A): balas 200 SEGERA setelah enqueue ("accepted for
      // delivery"). Menunggu pengiriman fisik bisa melebihi timeout 10s
      // orchestrator saat antrean dalam → memicu retry P1 → balasan dobel.
      sendQueue.enqueueMessage(sock, user_id, sendOptions)
        .catch(e => console.error('[Webhook] Gagal kirim fisik balasan:', e.message));
      res.status(200).json({ success: true });

      // ========== TASK-048 Fase 1b + TASK-050 Fase 1d: Simpan assistant response ==========
      // Pakai request_id sebagai externalMessageId untuk idempotency (webhook retry).
      try {
        const isGroup = typeof user_id === 'string' && user_id.endsWith('@g.us');
        const scope_type = isGroup ? 'group' : 'personal';
        await memoryStore.saveAssistantResponse(
          scope_type,
          user_id,
          response,
          {
            from_webhook: true,
            request_received_at: new Date().toISOString(),
          },
          request_id || null  // TASK-050: externalMessageId untuk dedup
        );
        if (request_id) {
          console.log(`[Memory] ✅ Assistant response saved (scope=${scope_type}:${user_id}, ext_id=${request_id})`);
        } else {
          console.log(`[Memory] ✅ Assistant response saved (scope=${scope_type}:${user_id}, no external_id)`);
        }
      } catch (memErr) {
        console.warn('[Memory] Gagal save assistant response (non-fatal):', memErr.message);
      }
      // =================================================================================
    } else {
      res.status(400).json({ error: "Invalid payload or socket not ready" });
    }
  } catch (err) {
    console.error("[Webhook Error]:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint untuk mengambil data anggota grup
app.get('/api/group/:group_id/members', async (req, res) => {
  try {
    const groupId = req.params.group_id;
    if (!sock) return res.status(500).json({ error: "Socket not ready" });

    const groupMeta = await sock.groupMetadata(groupId);
    res.status(200).json({
      subject: groupMeta.subject,
      participants: groupMeta.participants
    });
  } catch (err) {
    console.error(`[API Error] Gagal fetch group members untuk ${req.params.group_id}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/group/:group_id/messages', async (req, res) => {
  const groupId = req.params.group_id;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const scopeType = groupId.endsWith('@g.us') ? 'group' : 'user';
    const msgs = await memoryStore.getAllRecentTurns(scopeType, groupId, limit);
    const formatted = msgs.map(m => ({
      sender: m.role === 'assistant' ? 'Bot' : (m.metadata?.sender_id || groupId),
      text: m.content,
      time: m.created_at
    }));
    res.status(200).json({ messages: formatted });
  } catch (err) {
    console.error("[API Error] Gagal membaca pesan dari DB:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Bind host — lihat BIND_ADMIN_LOCALHOST di atas.
const BIND_HOST = BIND_ADMIN_LOCALHOST ? '127.0.0.1' : '0.0.0.0';
app.listen(WEBHOOK_PORT, BIND_HOST, () => {
  console.log(`🚀 Webhook Server berjalan di ${BIND_HOST}:${WEBHOOK_PORT}`);
  if (BIND_ADMIN_LOCALHOST) {
    console.log('   [Admin UI] http://127.0.0.1:' + WEBHOOK_PORT + '/admin/?token=$ADMIN_TOKEN');
  } else {
    console.warn('   [⚠️ Admin UI] http://0.0.0.0:' + WEBHOOK_PORT + '/admin/* (EXPOSED — pakai reverse proxy!)');
  }
});

// =============================================================================
// TASK-054 (Fase 5): Handler command `!ingat` / `!lupa` / `!profile` / `!memory`
// =============================================================================
// Command synchronous (tidak lewat orchestrator/LLM) — langsung query DB.
// Format:
//   !ingat <key>: <value>   → simpan explicit memory
//   !lupa <key>             → hapus explicit memory
//   !profile <key> <value>  → simpan profile memory (preferences)
//   !memory                 → list semua explicit memory
// =============================================================================
function parseKeyValue(rawText, prefix) {
  // Returns { key, value, error }
  const stripped = rawText.trim().slice(prefix.length).trim();
  // Support !ingat <key>: <value> (with colon) and !profile <key> <value> (space)
  if (prefix.startsWith('!ingat') || prefix.startsWith('!remember')) {
    const colonIdx = stripped.indexOf(':');
    if (colonIdx < 0) {
      return { error: `Format salah. Gunakan: ${prefix} <key>: <value>` };
    }
    const key = stripped.slice(0, colonIdx).trim();
    const value = stripped.slice(colonIdx + 1).trim();
    if (!key || !value) {
      return { error: `Key dan value tidak boleh kosong.` };
    }
    return { key, value };
  } else if (prefix.startsWith('!profile')) {
    // !profile <key> <value>  (value boleh multi-word tanpa kutip)
    const spaceIdx = stripped.indexOf(' ');
    if (spaceIdx < 0) {
      return { error: `Format salah. Gunakan: !profile <key> <value>` };
    }
    const key = stripped.slice(0, spaceIdx).trim();
    const value = stripped.slice(spaceIdx + 1).trim();
    if (!key || !value) {
      return { error: `Key dan value tidak boleh kosong.` };
    }
    return { key, value };
  } else if (prefix.startsWith('!lupa') || prefix.startsWith('!forget')) {
    return { key: stripped.trim(), value: null };
  }
  return { error: 'Prefix tidak dikenal.' };
}

async function handleMemoryCommand(routerResult, rawText) {
  if (!routerResult.command) return null;
  const { type, memoryType } = routerResult.command;
  const { scope_type, scope_id } = routerResult;

  try {
    if (type === 'save_explicit') {
      const prefix = rawText.toLowerCase().startsWith('!remember') ? '!remember'
        : rawText.toLowerCase().startsWith('!profile') ? '!profile'
        : '!ingat';
      const parsed = parseKeyValue(rawText, prefix);
      if (parsed.error) return parsed.error;
      const result = await memoryStore.saveExplicitMemory(
        scope_type, scope_id, parsed.key, parsed.value, { memoryType }
      );
      return `✅ Tersimpan! ${memoryType} memory *${parsed.key}* (v${result.version})${result.is_insert ? ' — baru' : ' — update'}.`;
    }

    if (type === 'delete_explicit') {
      const parsed = parseKeyValue(rawText, '!lupa');
      if (parsed.error || !parsed.key) return `Format: !lupa <key>`;
      const result = await memoryStore.deleteExplicitMemory(
        scope_type, scope_id, parsed.key, memoryType
      );
      if (result.deleted_count === 0) {
        return `ℹ️ Key *${parsed.key}* tidak ditemukan.`;
      }
      return `🗑️ Dihapus: *${parsed.key}* (${result.deleted_count} row).`;
    }

    if (type === 'list_explicit') {
      const items = await memoryStore.listExplicitMemory(scope_type, scope_id, memoryType);
      if (items.length === 0) {
        return `📭 Belum ada ${memoryType} memory. Coba: \`!ingat nama: Budi\``;
      }
      const lines = items.map((it, i) => `${i + 1}. *${it.key}* = ${it.content} _(v${it.version})_`);
      return `🧠 *${memoryType.toUpperCase()} Memory* (${items.length}):\n${lines.join('\n')}`;
    }
    return null;
  } catch (err) {
    console.error(`[Memory Command] Error:`, err.message);
    return `❌ Gagal: ${err.message}`;
  }
}

// Inisialisasi Baileys WhatsApp Bot
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['Mac OS', 'chrome', '121.0.6167.159'],
    syncFullHistory: false,
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (c.name || c.notify) {
        waContacts[c.id] = c;
      }
    }
    const fs = require('fs');
    fs.writeFile('./wa_contacts.json', JSON.stringify(waContacts, null, 2), (err) => {
      if (err) console.error('[Contacts] Gagal save wa_contacts.json (async):', err.message);
    });

    // ===== TASK-053: Real-time DB upsert (fire-and-forget) =====
    // Sinkron ke public.member_profiles. Tidak await — user latency tidak boleh terganggu.
    // contacts_sync_v2.py mingguan akan backfill + reclassify segment.
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) {
        upsertContactToDb(c).catch(err =>
          console.warn(`[Contacts] Unhandled error untuk ${c.id}: ${err.message}`)
        );
      }
    }
    // =====================================================
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR code ini dengan WhatsApp di HP kamu:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Error detail:', lastDisconnect?.error);
      console.log(
        'Koneksi terputus.',
        shouldReconnect ? 'Menyambung ulang...' : 'Logout. Hapus folder auth_info/ lalu jalankan ulang.'
      );
      // PATCH STABILITAS P1: reconnect terjadwal & ter-guard (tidak ada lagi
      // setTimeout(startBot) ganda). 440 = conflict (sesi dibuka di tempat
      // lain) → beri jeda lebih panjang agar tidak perang reconnect.
      if (shouldReconnect) {
        if (statusCode === 440) {
          console.warn('[Reconnect] ⚠️ Conflict 440: sesi dibuka di tempat lain. Reconnect dalam 30s...');
          scheduleReconnect(30000);
        } else {
          scheduleReconnect(statusCode === 515 ? 2000 : 5000);
        }
      }
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');

      // ===== SCHEDULER BRIEFING PAGI =====
      if (cronBriefingJobs && cronBriefingJobs.length > 0) {
        cronBriefingJobs.forEach(job => job.stop());
        cronBriefingJobs = [];
      }
      
      let briefingTargets = [];
      try {
        if (process.env.BRIEFING_TARGETS) {
          briefingTargets = JSON.parse(process.env.BRIEFING_TARGETS);
        } else {
          // Fallback backward-compatible
          briefingTargets = [{
            jid: process.env.BRIEFING_GROUP_JID || '120363426109888899@g.us',
            name: process.env.BRIEFING_GROUP_NAME || 'Briefing Group',
            cron: process.env.BRIEFING_CRON || '0 8 * * 1-5',
            context: null
          }];
        }
      } catch (err) {
        console.error('[Init] ❌ Gagal parse BRIEFING_TARGETS JSON. Menggunakan fallback.', err.message);
        briefingTargets = [{
          jid: process.env.BRIEFING_GROUP_JID || '120363426109888899@g.us',
          name: process.env.BRIEFING_GROUP_NAME || 'Briefing Group',
          cron: process.env.BRIEFING_CRON || '0 8 * * 1-5',
          context: null
        }];
      }

      // TASK-108 (review follow-up, opsi A): gabungkan grup aktif dari DB
      // whatsapp_bot.group_configs dengan target env. Dedup by jid diterapkan
      // setelahnya — target ENV menang atas DB bila jid sama.
      try {
        const dbGroups = await groupConfig.getActiveBriefingGroups();
        if (dbGroups.length > 0) {
          const envCount = briefingTargets.length;
          const mapped = dbGroups.map(g => ({
            jid: g.group_id,
            name: g.group_name,
            context: g.briefing_characteristics || null,
            cron: null,  // DB belum menyimpan jadwal — pakai default
          }));
          briefingTargets = briefingTargets.concat(mapped);
          console.log(`[Briefing] Gabungan target: ${envCount} env + ${mapped.length} DB`);
        }
      } catch (dbErr) {
        console.warn('[Briefing] ⚠️ Gagal membaca group_configs (lanjut env-only):', dbErr.message);
      }

      // REVIEW-FIX TASK-108 (minor): dedup target by jid — entri ganda di
      // BRIEFING_TARGETS tidak boleh mengirim briefing 2x ke grup yang sama.
      {
        const seenJids = new Set();
        briefingTargets = briefingTargets.filter(t => {
          if (!t || !t.jid) return false;
          if (seenJids.has(t.jid)) {
            console.warn(`[Briefing] ⏭️ Target duplikat di-skip: ${t.name || t.jid} (${t.jid})`);
            return false;
          }
          seenJids.add(t.jid);
          return true;
        });
      }

      console.log(`[Briefing] Menjadwalkan briefing pagi untuk ${briefingTargets.length} target...`);
      briefingTargets.forEach((target, index) => {
        const cronExpr = target.cron || '0 8 * * 1-5';
        console.log(`  -> Target ${index + 1}: ${target.name} (${target.jid}) pada cron "${cronExpr}"`);
        
        // REVIEW-FIX TASK-108 (minor): cron tidak valid pada satu target tidak
        // boleh menggagalkan penjadwalan target lainnya.
        let job;
        try {
          job = cron.schedule(cronExpr, () => {
            console.log(`[Briefing] Trigger jadwal briefing untuk ${target.name}!`);
            briefing.sendBriefing(sock, target).then(result => {
              if (result.success) {
                console.log(`[Briefing] ✅ Briefing pagi untuk ${target.name} berhasil dikirim.`);
              } else {
                console.error(`[Briefing] ❌ Briefing pagi untuk ${target.name} gagal:`, result.error);
              }
            });
          }, {
            timezone: 'Asia/Jakarta'
          });
        } catch (cronErr) {
          console.error(`[Briefing] ❌ Cron tidak valid untuk ${target.name}: "${cronExpr}" — target di-skip.`, cronErr.message);
          return;
        }
        
        cronBriefingJobs.push(job);
      });

      // ===== SCHEDULER PURGE MEMORY EXPIRED (TASK-047) =====
      const PURGE_CRON = process.env.WHATSAPP_MEMORY_PURGE_CRON || '0 3 * * *';
      if (cronPurge) cronPurge.stop();
      cronPurge = cron.schedule(PURGE_CRON, () => {
        console.log('[Memory] Trigger purge expired memories...');
        memoryStore.purgeExpired().catch(err =>
          console.error('[Memory] Purge job error:', err.message)
        );
      }, { timezone: 'Asia/Jakarta' });

      // ===== TASK-055 (Fase 2): ConsolidationJob scheduler =====
      // Setiap jam 04:00 WIB, jalankan runConsolidationJob() untuk scan
      // durable memory yang belum di-consolidate, similarity check, dan merge.
      const CONSOLIDATION_CRON = process.env.WHATSAPP_MEMORY_CONSOLIDATION_CRON || '0 4 * * *';
      if (cronConsolidasi) cronConsolidasi.stop();
      cronConsolidasi = cron.schedule(CONSOLIDATION_CRON, () => {
        console.log('[Memory] 🧠 Trigger ConsolidationJob (Fase 2)...');
        memoryStore.runConsolidationJob({
          batchSize: parseInt(process.env.WHATSAPP_MEMORY_CONSOLIDATION_BATCH || '50', 10),
          similarityThreshold: parseFloat(process.env.WHATSAPP_MEMORY_CONSOLIDATION_SIMILARITY || '0.85'),
        }).then((stats) => {
          console.log(`[Memory] 🧠 ConsolidationJob selesai: ${JSON.stringify(stats)}`);
        }).catch(err =>
          console.error('[Memory] ConsolidationJob error:', err.message)
        );
      }, { timezone: 'Asia/Jakarta' });

      // ===== TASK-057 (Fase 3): ImplicitAggregate scheduler =====
      // Setiap MINGGU 02:00 WIB, jalankan aggregateImplicitPatterns() untuk
      // scan pola interaksi user (recent user messages 7 hari terakhir)
      // dan simpan sebagai memory_type='implicit' (soft-delete 90 hari).
      const IMPLICIT_CRON = process.env.WHATSAPP_MEMORY_IMPLICIT_CRON || '0 2 * * 0';
      console.log(`[Memory] ImplicitAggregate dijadwalkan: cron="${IMPLICIT_CRON}" (timezone Asia/Jakarta)`);
      if (cronImplicit) cronImplicit.stop();
      cronImplicit = cron.schedule(IMPLICIT_CRON, () => {
        console.log('[Memory] 🧠 Trigger ImplicitAggregate (Fase 3)...');
        memoryStore.aggregateImplicitPatterns({
          minInteractions: parseInt(process.env.WHATSAPP_MEMORY_IMPLICIT_MIN_INTERACTIONS || '5', 10),
          topN: parseInt(process.env.WHATSAPP_MEMORY_IMPLICIT_TOP_N || '10', 10),
          lookbackDays: parseInt(process.env.WHATSAPP_MEMORY_IMPLICIT_LOOKBACK_DAYS || '7', 10),
        }).then((stats) => {
          console.log(`[Memory] 🧠 ImplicitAggregate selesai: ${JSON.stringify(stats)}`);
        }).catch(err =>
          console.error('[Memory] ImplicitAggregate error:', err.message)
        );
      }, { timezone: 'Asia/Jakarta' });

      // ===== TASK-057 (Fase 3): Implicit purge scheduler (daily) =====
      // Setiap jam 03:30 WIB, hapus implicit memory yang sudah expire.
      // (Sama jadwalnya dengan purge recent, tapi beda filter memory_type.)
      const IMPLICIT_PURGE_CRON = process.env.WHATSAPP_MEMORY_IMPLICIT_PURGE_CRON || '30 3 * * *';
      if (cronImplicitPurge) cronImplicitPurge.stop();
      cronImplicitPurge = cron.schedule(IMPLICIT_PURGE_CRON, () => {
        console.log('[Memory] 🧹 Trigger implicit purge (Fase 3)...');
        memoryStore.purgeImplicitOlderThan(0).then((r) => {
          if (r.deleted_count > 0) console.log(`[Memory] 🧹 Implicit purged: ${r.deleted_count}`);
        }).catch(err =>
          console.error('[Memory] Implicit purge error:', err.message)
        );
      }, { timezone: 'Asia/Jakarta' });
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const isFromMe = msg.key.fromMe;
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid?.endsWith('@g.us');

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text) return;

    // PATCH STABILITAS P1: skip pesan duplikat. WhatsApp mengirim ulang pesan
    // yang belum ter-ack setelah reconnect — tanpa ini user menerima balasan dobel.
    if (isDuplicateMessage(msg.key?.id)) {
      console.log(`[Dedup] ⏭️ Pesan ${msg.key?.id} sudah diproses, skip.`);
      return;
    }

    // ========== TASK-050 Fase 1d: Generate requestId untuk round-trip idempotency ==========
    const requestId = crypto.randomUUID();

    // ========== TASK-047 Fase 1a: Memori router ==========
    const routerResult = memoryRouter.selectMemoryStores({
      remoteJid,
      isGroup,
      text,
    });

    // ========== TASK-054 (Fase 5): Short-circuit command handler ==========
    // Jika pesan adalah command `!ingat` / `!lupa` / `!profile` / `!memory`,
    // tangani langsung di sini (sync, tidak ke orchestrator).
    if (routerResult.command) {
      // Hanya proses di personal chat atau jika fromMe (admin self-test)
      if (!isGroup || isFromMe) {
        try {
          const reply = await handleMemoryCommand(routerResult, text);
          if (reply) {
            await sendQueue.enqueueMessage(sock, remoteJid, { text: reply }, { quoted: msg });
            console.log(`[Memory Command] ✅ Replied to ${remoteJid}: ${reply.split('\n')[0]}`);
            return;  // jangan forward ke orchestrator
          }
        } catch (cmdErr) {
          console.error('[Memory Command] Gagal:', cmdErr.message);
          // REVIEW-FIX TASK-107: .catch agar kegagalan kirim tidak bocor ke unhandledRejection
          sendQueue.enqueueMessage(sock, remoteJid, {
            text: `❌ Error: ${cmdErr.message}`,
          }, { quoted: msg }).catch(e => console.error('[SendQueue] Gagal kirim error command:', e.message));
          return;
        }
      }
    }

    if (routerResult.active) {
      // TASK-050 Fase 1d: Fire-and-forget save user message (non-blocking)
      // User's latency tidak boleh terganggu oleh logging I/O.
      // Error tetap di-log via .catch() agar tidak silent failure.
      const quotedMessageId = msg.message.extendedTextMessage?.contextInfo?.stanzaId
        || msg.message.imageMessage?.contextInfo?.stanzaId
        || null;

      let enrichedGroupName = null;
      if (isGroup) {
        sock.groupMetadata(remoteJid).then(gmeta => {
          enrichedGroupName = gmeta.subject;
        }).catch(() => { /* ignore */ });
      }

      // PENTING: tidak await. saveMessage berjalan paralel dengan forward ke orchestrator.
      memoryStore.saveMessage(
        routerResult.scope_type,
        routerResult.scope_id,
        'user',
        text,
        {
          memoryType: 'recent',
          source: 'inferred',
          confidenceScore: 1.0,
          metadata: {
            isFromMe,
            sender_cid: msg.key.participant || msg.key.remoteJid,
            isGroup,
            pushName: msg.pushName || null,
            sender_name: msg.pushName || null,
            group_name: enrichedGroupName,
            router_reason: routerResult.reason,
          },
          quotedMessageId,
          externalMessageId: msg.key?.id || null,
        }
      ).then(result => {
        if (result.deduplicated) {
          console.log(`[Memory] ⏭️ User message deduplicated (ext_id=${msg.key?.id})`);
        } else {
          console.log(`[Memory] ✅ User message saved (id=${result.id})`);
        }
      }).catch(err => {
        console.warn('[Memory] Gagal save user message (non-fatal):', err.message);
      });
    }

    // --- Legacy Message Caching removed (moved to memoryStore) ---

    console.log(`📩 [DEBUG] Pesan masuk dari ${remoteJid}: "${text}" (request_id=${requestId})`);

    // Logika Trigger Bot
    if (isGroup) {
      const mentionedJidList = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const botNumber = sock.user?.id?.split(':')[0];
      const botJid = botNumber + '@s.whatsapp.net';
      const isMentioned = mentionedJidList.includes(botJid);

      const textLower = text.toLowerCase();
      const isTriggeredText = textLower.startsWith('!ai') || textLower.includes('@groq') || textLower.startsWith('groq');

      if (!isMentioned && !isTriggeredText) return;
    } else if (isFromMe) {
      const textLower = text.toLowerCase();
      const isTriggeredText = textLower.startsWith('!ai') || textLower.includes('@groq') || textLower.startsWith('groq');
      if (!isTriggeredText) return;
    }

    try {
      await sock.sendPresenceUpdate('composing', remoteJid);
      const ackMsg = await sendQueue.enqueueMessage(sock, remoteJid, { text: "⏳ Sedang memproses..." }, { quoted: msg });

      // PATCH STABILITAS P1: aktifkan watchdog — jika balasan orchestrator tidak
      // tiba tepat waktu, user diberi tahu (ack tidak menggantung selamanya).
      // Catatan: Karena await sendQueue, watchdog di-arm setelah pesan benar-benar terkirim ke jaringan.
      armResponseWatchdog(requestId, remoteJid, msg);

      let groupName = null;
      let senderId = msg.key.participant || msg.key.remoteJid;
      let senderName = msg.pushName || null;

      if (isGroup) {
        try {
          const groupMeta = await sock.groupMetadata(remoteJid);
          groupName = groupMeta.subject;
        } catch (e) {
          console.error("Gagal mendapat metadata grup:", e);
        }
      }

      // ========== TASK-047 Fase 1a: Ambil history (TETAP await — ini critical path) ==========
      let history = [];
      if (routerResult.active && routerResult.memory_types.includes('recent')) {
        try {
          const turns = await memoryStore.getRecentTurns(
            routerResult.scope_type,
            routerResult.scope_id,
            parseInt(process.env.WHATSAPP_MEMORY_RECENT_LIMIT || '10', 10)
          );
          history = turns.map(t => ({ role: t.role, content: t.content }));
        } catch (histErr) {
          console.warn('[Memory] Gagal ambil history (non-fatal):', histErr.message);
        }
      }
      // =====================================================================================

      // Teruskan pesan ke FastAPI Backend
      // TASK-050 Fase 1d: kirim requestId agar orchestrator bisa echo di webhook
      const payload = {
        platform: "whatsapp",
        user_id: remoteJid,
        message: text,
        webhook_url: `${WEBHOOK_HOST}/webhook/whatsapp`,
        sender_id: senderId,
        sender_name: senderName,
        group_name: groupName,
        history: history,
        request_id: requestId,  // TASK-050: untuk idempotency round-trip
      };

      await axios.post(FASTAPI_URL, payload, {
        headers: {
          'X-Webhook-Secret': WEBHOOK_SECRET
        },
        timeout: 15000,  // PATCH STABILITAS P1: jangan hang tanpa batas menunggu "queued"
      });
      console.log(`[API] Berhasil mengirim pesan ke Orchestrator (request_id=${requestId})`);

    } catch (err) {
      console.error('Gagal mengirim ke FastAPI Backend:', err.message);
      disarmResponseWatchdog(requestId);  // PATCH STABILITAS P1: user sudah diberi tahu gagal
      // REVIEW-FIX TASK-107: .catch agar kegagalan kirim pesan error tidak bocor
      // ke unhandledRejection (misal saat socket down / antrean penuh).
      sendQueue.enqueueMessage(sock, remoteJid, {
        text: '❌ Maaf, server AI sedang sibuk atau mati.',
      }).catch(e => console.error('[SendQueue] Gagal kirim pesan error:', e.message));
    }
  });
}

// PATCH STABILITAS P1: tangkap error startup secara eksplisit. Sebelumnya
// `startBot()` tanpa .catch — kegagalan fetchLatestBaileysVersion() (network
// down saat boot) menjadi unhandled rejection → Node exit tanpa log jelas →
// crash-loop systemd (dan bisa kena start-limit → bot mati total).
startBotGuarded().catch(err => {
  console.error('[FATAL] startBot gagal saat startup:', err);
  process.exit(1); // biarkan systemd merestart dengan log yang jelas
});

// Jangan biarkan rejection liar membunuh proses tanpa jejak.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1); // state tidak bisa dipercaya — restart bersih via systemd
});
