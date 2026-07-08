require('dotenv').config({ path: '../../.env' });
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function test() {
  const { state } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('connection.update', async (update) => {
    if (update.connection === 'open') {
      console.log('Connected');
      try {
        const groupMeta = await sock.groupMetadata('120363426109888899@g.us');
        console.log("First participant object:", groupMeta.participants[0]);
      } catch (e) {
        console.error(e);
      }
      process.exit(0);
    }
  });
}
test();
