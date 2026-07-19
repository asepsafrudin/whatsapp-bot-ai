// send_queue.js
// Antrean global FIFO untuk pengiriman pesan WhatsApp guna menghindari ban/spam detection.

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SendQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.minInterval = parseInt(process.env.WA_SEND_MIN_INTERVAL_MS || '1500', 10);
    this.jitter = parseInt(process.env.WA_SEND_JITTER_MS || '1200', 10);
  }

  /**
   * Menambahkan pesan ke dalam antrean.
   * Mengembalikan Promise yang di-resolve saat pesan FISIK terkirim ke WhatsApp.
   */
  enqueueMessage(sock, jid, message, options = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        sock,
        jid,
        message,
        options,
        resolve,
        reject
      });
      console.log(`[SendQueue] 📥 Enqueued message to ${jid} (depth=${this.queue.length})`);
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      try {
        const result = await task.sock.sendMessage(task.jid, task.message, task.options);
        task.resolve(result);
      } catch (err) {
        console.error(`[SendQueue] ❌ Error sending message to ${task.jid}:`, err.message);
        task.reject(err);
      }

      // Jika masih ada pesan di antrean, terapkan rate-limit + jitter
      if (this.queue.length > 0) {
        const currentJitter = Math.floor(Math.random() * this.jitter);
        const waitTime = this.minInterval + currentJitter;
        console.log(`[SendQueue] ⏳ Waiting... delay=${waitTime}ms (depth=${this.queue.length})`);
        await delayMs(waitTime);
      }
    }

    this.isProcessing = false;
  }
}

// Singleton export
module.exports = new SendQueue();
