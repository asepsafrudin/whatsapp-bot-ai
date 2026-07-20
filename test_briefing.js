const { sendBriefing } = require('./briefing');

async function test() {
  const dummySock = { sendMessage: (jid, msg) => console.log('Mock send to', jid) };
  console.log("Memanggil sendBriefing...");
  const result = await sendBriefing(dummySock);
  console.log("Result:", JSON.stringify(result, null, 2));
}

test();
