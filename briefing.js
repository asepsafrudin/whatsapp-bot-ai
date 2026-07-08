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
const FASTAPI_URL = process.env.FASTAPI_URL || 'http://localhost:8001/api/v1';
const WEBHOOK_HOST = process.env.WEBHOOK_HOST || 'http://localhost:3001';
const BRIEFING_GROUP_JID = process.env.BRIEFING_GROUP_JID || '120363426109888899@g.us';

// ====================== SEND BRIEFING ======================
async function sendBriefing(sock) {
  console.log('[Briefing] Memulai proses briefing WhatsApp pagi...');

  if (!sock) {
    console.error('[Briefing] Socket Baileys belum tersedia. Briefing dibatalkan.');
    return { success: false, error: 'Socket tidak tersedia' };
  }

  try {
    console.log(`[Briefing] Mengirim request generate briefing ke ai-orchestrator: ${FASTAPI_URL}/briefing`);
    console.log(`[Briefing] Target grup: ${BRIEFING_GROUP_JID}`);

    const payload = {
      platform: 'whatsapp',
      user_id: BRIEFING_GROUP_JID,
      message: 'GENERATE_MORNING_BRIEFING',
      webhook_url: `${WEBHOOK_HOST}/webhook/whatsapp`,
      sender_id: null,
      sender_name: 'Briefing Bot',
      group_name: 'GREEN GARDEN GHS'
    };

    const res = await axios.post(`${FASTAPI_URL}/briefing`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': process.env.WEBHOOK_SECRET
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