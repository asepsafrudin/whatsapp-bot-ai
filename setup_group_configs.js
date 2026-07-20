require('dotenv').config({ path: '../../.env' });
const db = require('./memory/db');

async function setup() {
  try {
    console.log("Membuat tabel whatsapp_bot.group_configs...");
    await db.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_bot.group_configs (
          group_id VARCHAR(50) PRIMARY KEY,
          group_name VARCHAR(255),
          is_active BOOLEAN DEFAULT true,
          briefing_characteristics TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("Menyisipkan data grup...");
    const groups = [
      {
        id: '120363427529184049@g.us',
        name: 'General',
        char: 'Formal, fokus ke update informasi umum dinamika perumahan subsidi yang diceritakan kembali ke warga Griya Hasanah Sukaasih atau GHS, karena group ini berisi tim pengurus perumahan griya hasanah sukaasih.'
      },
      {
        id: '120363429680018640@g.us',
        name: 'Pembangunan pasos',
        char: 'Sangat santai, banyak jokes lucu ala pekerja proyek, pakai bahasa gaul. saat ini proyek yang sedang dibangun adalah fasos lapangan bulutangkis'
      },
      {
        id: '120363426109888899@g.us',
        name: 'GREEN GARDEN GHS',
        char: 'santai berfokus candaan seputar perumahan bersubsidi, nasihat kerukunan, nasehat disiplin administrasi'
      }
    ];

    for (const g of groups) {
      await db.query(`
        INSERT INTO whatsapp_bot.group_configs (group_id, group_name, briefing_characteristics, is_active)
        VALUES ($1, $2, $3, true)
        ON CONFLICT (group_id) DO UPDATE 
        SET briefing_characteristics = EXCLUDED.briefing_characteristics,
            group_name = EXCLUDED.group_name,
            updated_at = NOW();
      `, [g.id, g.name, g.char]);
      console.log(`Grup disisipkan: ${g.name}`);
    }
    
    console.log("Selesai setup database!");
  } catch(e) {
    console.error("Error:", e);
  } finally {
    await db.close();
  }
}
setup();
