require('dotenv').config({ path: '../../.env' });
const db = require('./memory/db');

async function getGroups() {
  try {
    const res2 = await db.query(`
      SELECT DISTINCT scope_id 
      FROM whatsapp_bot.memories 
      WHERE scope_type = 'group'
    `);
    
    console.log("\n=== DAFTAR GRUP WHATSAPP (DARI MEMORIES) ===");
    for (const row of res2.rows) {
      console.log(`ID: ${row.scope_id}`);
      
      // try to fetch group name if available
      const md = await db.query(`
        SELECT metadata->>'group_name' as group_name
        FROM whatsapp_bot.memories
        WHERE scope_id = $1 AND scope_type = 'group' AND metadata->>'group_name' IS NOT NULL
        LIMIT 1
      `, [row.scope_id]);
      if(md.rows.length > 0) {
        console.log(`Nama Grup: ${md.rows[0].group_name}`);
      }
    }
  } catch(e) {
    console.error("Error query db:", e);
  } finally {
    await db.close();
  }
}
getGroups();
