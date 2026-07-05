require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const P = require('pino');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Kamu adalah asisten WhatsApp yang ramah, singkat, dan membantu. Jawab dalam bahasa yang sama dengan pesan yang masuk.';

const REPLY_TO_GROUPS = (process.env.REPLY_TO_GROUPS || 'false').toLowerCase() === 'true';

// Simpan histori percakapan sederhana per nomor (in-memory, hilang saat restart)
const conversationHistory = new Map();
const MAX_HISTORY = 10; // jumlah pesan yang disimpan per kontak

function getHistory(jid) {
  if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
  return conversationHistory.get(jid);
}

function pushHistory(jid, role, content) {
  const history = getHistory(jid);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR code ini dengan WhatsApp di HP kamu (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        'Koneksi terputus.',
        shouldReconnect ? 'Menyambung ulang...' : 'Logout. Hapus folder auth_info/ lalu jalankan ulang untuk login baru.'
      );
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid?.endsWith('@g.us');
    if (isGroup && !REPLY_TO_GROUPS) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!text) return;

    console.log(`📩 Pesan dari ${remoteJid}: ${text}`);

    try {
      await sock.sendPresenceUpdate('composing', remoteJid);

      pushHistory(remoteJid, 'user', text);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...getHistory(remoteJid)],
      });

      const reply =
        completion.choices[0]?.message?.content?.trim() ||
        'Maaf, saya tidak bisa menjawab itu sekarang.';

      pushHistory(remoteJid, 'assistant', reply);

      await sock.sendMessage(remoteJid, { text: reply });
    } catch (err) {
      console.error('Gagal proses AI:', err.message);
      await sock.sendMessage(remoteJid, {
        text: 'Maaf, terjadi kesalahan saat memproses pesanmu. Coba lagi sebentar.',
      });
    }
  });
}

startBot();
