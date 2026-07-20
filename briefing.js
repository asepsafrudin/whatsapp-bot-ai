// ==============================================================================
// WhatsApp Morning Fun Briefing Module (Integrated with ai-orchestrator)
// ==============================================================================
// Lokasi: services/whatsapp-bot-ai/briefing.js
// Deskripsi: Trigger briefing generation via ai-orchestrator LangGraph backend,
//            kemudian mengirimkannya ke grup WhatsApp via Baileys.
// ==============================================================================

const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

// ====================== CONFIGURATION ======================
// PATCH STABILITAS P1: FASTAPI_URL di index.js diperlakukan sebagai FULL PATH
// (default .../api/v1/chat), sedangkan briefing.js dulu meng-append '/briefing'
// ke var yang sama -> request ke '/api/v1/chat/briefing' -> 404.
// Solusi: normalisasi ke BASE URL '/api/v1', terlepas dari bentuk env-nya.
const _rawFastapiUrl = process.env.FASTAPI_URL || 'http://localhost:8001/api/v1/chat';
const FASTAPI_URL = _rawFastapiUrl.replace(/\/api\/v1\/chat\/?$/, '/api/v1').replace(/\/$/, '');
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'http://localhost:3001';
const DEFAULT_BRIEFING_GROUP_JID = process.env.BRIEFING_GROUP_JID || '120363426109888899@g.us';
const DEFAULT_BRIEFING_GROUP_NAME = process.env.BRIEFING_GROUP_NAME || 'Briefing Group';

// ====================== SEND BRIEFING ======================
async function sendBriefing(sock, target = null) {
  const jid = target?.jid || DEFAULT_BRIEFING_GROUP_JID;
  const name = target?.name || DEFAULT_BRIEFING_GROUP_NAME;
  const ctx = target?.context || null;

  console.log(`[Briefing] Memulai proses briefing WhatsApp pagi untuk grup: ${name} (${jid})...`);

  if (!sock) {
    console.error('[Briefing] Socket Baileys belum tersedia. Briefing dibatalkan.');
    return { success: false, error: 'Socket tidak tersedia' };
  }

  try {
    console.log(`[Briefing] Mengirim request generate briefing ke ai-orchestrator: ${FASTAPI_URL}/briefing`);

    const payload = {
      platform: 'whatsapp',
      user_id: jid,
      message: 'GENERATE_MORNING_BRIEFING',
      webhook_url: `${WEBHOOK_HOST}/webhook/whatsapp`,
      sender_id: null,
      sender_name: 'Briefing Bot',
      group_name: name
    };
    
    if (ctx) {
      payload.context = ctx;
    }

    const res = await axios.post(`${FASTAPI_URL}/briefing`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET || process.env.MCP_WEBHOOK_SECRET
      },
      timeout: 10000
    });

    console.log(`[Briefing] Request diterima ai-orchestrator: ${res.data.status}`);
    return { success: true, result: res.data };

  } catch (err) {
    console.error(`[Briefing] Gagal meminta briefing ke ai-orchestrator: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ====================== EXPORTS ======================
module.exports = {
  sendBriefing
};