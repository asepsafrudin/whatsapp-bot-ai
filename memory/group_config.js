'use strict';

const db = require('./db');

/**
 * Mengambil daftar grup yang aktif untuk menerima briefing.
 * @returns {Promise<Array<{group_id: string, group_name: string, briefing_characteristics: string}>>}
 */
async function getActiveBriefingGroups() {
  try {
    const sql = `
      SELECT group_id, group_name, briefing_characteristics 
      FROM whatsapp_bot.group_configs 
      WHERE is_active = true
    `;
    const { rows } = await db.query(sql);
    return rows;
  } catch (err) {
    console.error('[group_config] ❌ Error getActiveBriefingGroups:', err.message);
    return [];
  }
}

module.exports = {
  getActiveBriefingGroups
};
