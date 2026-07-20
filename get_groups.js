require('dotenv').config({ path: '../../.env' });
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function getGroups() {
  const { state } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open') {
      try {
        const groups = await sock.groupFetchAllParticipating();
        console.log("\n=== DAFTAR GRUP WHATSAPP ===");
        for (const [id, group] of Object.entries(groups)) {
          console.log(`ID: ${id}`);
          console.log(`Nama: ${group.subject}`);
          console.log('----------------------------');
        }
      } catch (e) {
        console.error("Gagal mendapatkan grup:", e);
      }
      process.exit(0);
    }
  });
}
getGroups();
