require('dotenv').config({ path: '../../.env' });
const OpenAI = require('openai');

const apiKey = process.env.GROQ_API_KEY_BOT_WHATSAPP || process.env.GROQ_API_KEY;

if (!apiKey) {
  console.error("❌ ERROR: API Key Groq tidak ditemukan di .env");
  process.exit(1);
}

const openai = new OpenAI({ 
  apiKey: apiKey,
  baseURL: "https://api.groq.com/openai/v1"
});

async function testModels() {
  console.log("==================================================");
  console.log("🔍 MENGAMBIL DAFTAR MODEL DARI SERVER GROQ...");
  
  let availableModels = [];
  try {
    const modelsResponse = await openai.models.list();
    availableModels = modelsResponse.data.map(m => m.id).filter(id => !id.includes('whisper') && !id.includes('guard')); // abaikan model suara/guard
    console.log(`Ditemukan ${availableModels.length} model teks:`, availableModels.join(', '));
  } catch(err) {
    console.log("Gagal mengambil daftar model:", err.message);
    return;
  }

  console.log("\n==================================================");
  console.log("🔍 MEMULAI PENGUJIAN MODEL GROQ...");
  console.log("==================================================\n");

  for (const model of availableModels) {
    console.log(`Menguji model: [${model}] ...`);
    try {
      const response = await openai.chat.completions.create({
        model: model,
        messages: [{ role: 'user', content: 'Katakan "Halo" dalam 1 kata saja.' }],
        max_tokens: 10
      });
      console.log(`✅ BERHASIL! Respons: "${response.choices[0].message.content.trim()}"\n`);
    } catch (err) {
      if (err.response) {
        console.log(`❌ GAGAL: Ditolak oleh server (Status: ${err.status})`);
        console.log(`   Alasan: ${err.response.data?.error?.message || err.response.data}\n`);
      } else {
        console.log(`❌ GAGAL: ${err.message}\n`);
      }
    }
  }
  
  console.log("==================================================");
  console.log("🏁 PENGUJIAN SELESAI.");
  console.log("==================================================");
}

testModels();
