require('dotenv').config({ path: '../../.env' });
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const OpenAI = require('openai');
const P = require('pino');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

// Inisialisasi Groq (memakai OpenAI SDK tapi diarahkan ke API Groq)
const openai = new OpenAI({ 
  apiKey: process.env.GROQ_API_KEY_BOT_WHATSAPP || process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  'Kamu adalah asisten cerdas yang memiliki akses ke berbagai tools sistem. Jika pengguna meminta sesuatu yang bisa dikerjakan oleh tools (seperti membaca file, melihat info sistem, dll), gunakan tools tersebut. Jawab dalam bahasa yang ramah dan singkat. PENTING: Jangan pernah memodifikasi nama tool atau menambahkan karakter kurung kurawal {} pada nama tool. Jika tool tidak membutuhkan parameter, kirimkan parameter kosong yang valid (bukan menempelkan {} ke nama tool).';

const REPLY_TO_GROUPS = (process.env.REPLY_TO_GROUPS || 'false').toLowerCase() === 'true';

// Inisialisasi MCP Client
const transport = new StdioClientTransport({
  command: "C:\\Users\\aseps\\Projects\\.venv\\Scripts\\python.exe",
  args: ["C:\\Users\\aseps\\Projects\\src\\antigravity_mcp\\server.py"]
});

const mcpClient = new Client(
  { name: "whatsapp-bot-client", version: "1.0.0" },
  { capabilities: {} }
);

let mcpTools = [];

async function connectMCP() {
  console.log('Menghubungkan ke MCP Server Python...');
  await mcpClient.connect(transport);
  const toolsResponse = await mcpClient.listTools();
  mcpTools = toolsResponse.tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  }));
  console.log(`✅ MCP Server terhubung. ${mcpTools.length} tools siap digunakan.`);
}

// Simpan histori percakapan
const conversationHistory = new Map();
const MAX_HISTORY = 10;

function getHistory(jid) {
  if (!conversationHistory.has(jid)) conversationHistory.set(jid, []);
  return conversationHistory.get(jid);
}

function pushHistory(jid, role, content, additionalProps = {}) {
  const history = getHistory(jid);
  history.push({ role, content, ...additionalProps });
  while (history.length > MAX_HISTORY) history.shift();
}

async function startBot() {
  try {
    await connectMCP();
  } catch(err) {
    console.error("Gagal konek MCP:", err);
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'silent' }),
    browser: ['Mac OS', 'chrome', '121.0.6167.159'],
    syncFullHistory: false,
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
      console.log('Error detail:', lastDisconnect?.error);
      console.log(
        'Koneksi terputus.',
        shouldReconnect ? 'Menyambung ulang...' : 'Logout. Hapus folder auth_info/ lalu jalankan ulang untuk login baru.'
      );
      if (shouldReconnect) { setTimeout(startBot, 2000); }
    } else if (connection === 'open') {
      console.log('✅ Bot terhubung ke WhatsApp!');
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

    console.log(`📩 [DEBUG] Pesan masuk dari ${remoteJid}: "${text}"`);

    // Jika ini di dalam grup, bot HANYA merespons jika di-tag atau dipanggil
    if (isGroup) {
      const mentionedJidList = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const botNumber = sock.user?.id?.split(':')[0];
      const botJid = botNumber + '@s.whatsapp.net';
      
      const isMentioned = mentionedJidList.includes(botJid);
      
      const textLower = text.toLowerCase();
      const isTriggeredText = textLower.startsWith('!ai') || textLower.includes('@groq') || textLower.startsWith('groq');
      
      if (!isMentioned && !isTriggeredText) {
        return; // Abaikan chat grup biasa
      }
    } else {
      // Jika ini di chat pribadi, tapi pesannya DARI nomor bot sendiri (fromMe)
      // Abaikan KECUALI dia sengaja memanggil dengan trigger
      if (isFromMe) {
        const textLower = text.toLowerCase();
        const isTriggeredText = textLower.startsWith('!ai') || textLower.includes('@groq') || textLower.startsWith('groq');
        if (!isTriggeredText) return;
      }
    }

    try {
      await sock.sendPresenceUpdate('composing', remoteJid);

      pushHistory(remoteJid, 'user', text);
      const reqMessages = [{ role: 'system', content: SYSTEM_PROMPT }, ...getHistory(remoteJid)];

      let completion = await openai.chat.completions.create({
        model: GROQ_MODEL,
        messages: reqMessages,
        tools: mcpTools.length > 0 ? mcpTools : undefined,
      });

      let responseMessage = completion.choices[0]?.message;
      let iterations = 0;

      // Tool calling loop
      while (responseMessage?.tool_calls && iterations < 3) {
        reqMessages.push(responseMessage); // Simpan panggilan tool ke history sbg context

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          const fnArgs = toolCall.function.arguments;
          console.log(`[MCP] ⚙️ AI memanggil tool: ${fnName} dengan args: ${fnArgs}`);

          let resultStr = "";
          try {
            const parsedArgs = JSON.parse(fnArgs);
            const mcpResult = await mcpClient.callTool({ name: fnName, arguments: parsedArgs });
            resultStr = JSON.stringify(mcpResult);
            console.log(`[MCP] ✅ Hasil dari ${fnName} didapatkan.`);
          } catch (err) {
            console.error(`[MCP] ❌ Gagal mengeksekusi tool ${fnName}:`, err.message);
            resultStr = `Error executing tool: ${err.message}`;
          }

          reqMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: fnName,
            content: resultStr
          });
        }

        // Minta AI merespons ulang berdasarkan hasil tool
        completion = await openai.chat.completions.create({
          model: GROQ_MODEL,
          messages: reqMessages,
          tools: mcpTools.length > 0 ? mcpTools : undefined,
        });
        
        responseMessage = completion.choices[0]?.message;
        iterations++;
      }

      const finalReply = responseMessage?.content?.trim() || 'Selesai memproses (tanpa teks balasan).';
      pushHistory(remoteJid, 'assistant', finalReply);

      await sock.sendMessage(remoteJid, { text: finalReply });
    } catch (err) {
      console.error('Gagal proses AI:');
      console.error('Pesan Error:', err.message);
      if (err.response) {
        console.error('Detail dari API:', err.response.data);
        console.error('Status Code:', err.status);
      } else if (err.error) {
        console.error('Detail Error:', err.error);
      }
      
      await sock.sendMessage(remoteJid, {
        text: 'Maaf, terjadi kesalahan saat memproses pesanmu dengan AI.',
      });
    }
  });
}

startBot();
