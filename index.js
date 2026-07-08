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
// TASK-053: DB pool untuk contacts.upsert real-time → public.member_profiles
const memoryDb = require('./memory/db');

// Konfigurasi API
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001/api/v1/chat';
const WEBHOOK_PORT = process.env.WEBHOOK_PORT || 3001;
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'http://localhost:3001';

// Helper: baca WEBHOOK_SECRET dengan fallback MCP_WEBHOOK_SECRET (TASK-051)
const WEBHOOK_SECRET = process.env.MCP_WEBHOOK_SECRET || WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error('[Init] ❌ FATAL: WEBHOOK_SECRET / MCP_WEBHOOK_SECRET tidak diset di env.');
  console.error('[Init] Cek /home/aseps/MCP/config/env/.env.core atau .env.messaging');
}

// Inisialisasi Express Webhook Server
const app = express();
app.use(express.json());

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
const messageCache = {}; // Legacy in-memory ring buffer (per-JID)

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

    const { user_id, response, request_id } = req.body;  // TASK-050: terima request_id
    console.log(`[Webhook] Menerima balasan untuk: ${user_id} (request_id=${request_id || 'none'})`);

    if (sock && user_id && response) {
      // Kirim balasan ke WhatsApp
      await sock.sendMessage(user_id, { text: response });
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

app.get('/api/group/:group_id/messages', (req, res) => {
  const groupId = req.params.group_id;
  const limit = parseInt(req.query.limit) || 20;

  if (!messageCache[groupId]) {
      return res.status(200).json({ messages: [] });
  }

  const msgs = messageCache[groupId];
  const sliced = msgs.slice(Math.max(msgs.length - limit, 0));
  res.status(200).json({ messages: sliced });
});

app.listen(WEBHOOK_PORT, () => {
  console.log(`🚀 Webhook Server berjalan di port ${WEBHOOK_PORT}`);
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
    fs.writeFileSync('./wa_contacts.json', JSON.stringify(waContacts, null, 2));

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

  sock.ev.on('connection.update', (update) => {
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
      if (shouldReconnect) { setTimeout(startBot, 2000); }
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');

      // ===== SCHEDULER BRIEFING PAGI =====
      const BRIEFING_CRON = process.env.BRIEFING_CRON || '0 8 * * 1-5';
      console.log(`[Briefing] Menjadwalkan briefing pagi: cron="${BRIEFING_CRON}" ke grup ${process.env.BRIEFING_GROUP_JID || '120363426109888899@g.us'}`);

      cron.schedule(BRIEFING_CRON, () => {
        console.log('[Briefing] Trigger jadwal briefing!');
        briefing.sendBriefing(sock).then(result => {
          if (result.success) {
            console.log('[Briefing] ✅ Briefing pagi berhasil dikirim.');
          } else {
            console.error('[Briefing] ❌ Briefing pagi gagal:', result.error);
          }
        });
      }, {
        timezone: 'Asia/Jakarta'
      });

      // ===== SCHEDULER PURGE MEMORY EXPIRED (TASK-047) =====
      const PURGE_CRON = process.env.WHATSAPP_MEMORY_PURGE_CRON || '0 3 * * *';
      cron.schedule(PURGE_CRON, () => {
        console.log('[Memory] Trigger purge expired memories...');
        memoryStore.purgeExpired().catch(err =>
          console.error('[Memory] Purge job error:', err.message)
        );
      }, { timezone: 'Asia/Jakarta' });

      // ===== TASK-055 (Fase 2): ConsolidationJob scheduler =====
      // Setiap jam 04:00 WIB, jalankan runConsolidationJob() untuk scan
      // durable memory yang belum di-consolidate, similarity check, dan merge.
      const CONSOLIDATION_CRON = process.env.WHATSAPP_MEMORY_CONSOLIDATION_CRON || '0 4 * * *';
      cron.schedule(CONSOLIDATION_CRON, () => {
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
            await sock.sendMessage(remoteJid, { text: reply }, { quoted: msg });
            console.log(`[Memory Command] ✅ Replied to ${remoteJid}: ${reply.split('\n')[0]}`);
            return;  // jangan forward ke orchestrator
          }
        } catch (cmdErr) {
          console.error('[Memory Command] Gagal:', cmdErr.message);
          await sock.sendMessage(remoteJid, {
            text: `❌ Error: ${cmdErr.message}`,
          }, { quoted: msg });
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

    // --- Legacy Message Caching (ring buffer per-JID) ---
    if (!messageCache[remoteJid]) {
      messageCache[remoteJid] = [];
    }
    const sender_cid = msg.key.participant || msg.key.remoteJid;
    messageCache[remoteJid].push({
      sender: isFromMe ? "Bot" : sender_cid,
      text: text,
      time: new Date().toISOString()
    });
    if (messageCache[remoteJid].length > 100) {
      messageCache[remoteJid].shift();
    }
    // -----------------------------------------------------------------------

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
      const ackMsg = await sock.sendMessage(remoteJid, { text: "⏳ Sedang memproses..." }, { quoted: msg });

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
        }
      });
      console.log(`[API] Berhasil mengirim pesan ke Orchestrator (request_id=${requestId})`);

    } catch (err) {
      console.error('Gagal mengirim ke FastAPI Backend:', err.message);
      await sock.sendMessage(remoteJid, {
        text: '❌ Maaf, server AI sedang sibuk atau mati.',
      });
    }
  });
}

startBot();
