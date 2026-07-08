require('dotenv').config({ path: '../../.env' });
const { makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');

async function test() {
  const { state } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    console.log('Got contacts!', contacts.length);
    console.log(contacts[0]);
    process.exit(0);
  });
}
test();
