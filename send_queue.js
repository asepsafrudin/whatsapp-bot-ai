// send_queue.js
// Antrean global FIFO untuk pengiriman pesan WhatsApp guna menghindari ban/spam detection.

const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SendQueue {
  constructor() {
    this.queue = [];
    this.isProcessing = false;
    this.minInterval = parseInt(process.env.WA_SEND_MIN_INTERVAL_MS || '1500', 10);
    this.jitter = parseInt(process.env.WA_SEND_JITTER_MS || '1200', 10);
    // REVIEW-FIX TASK-107: batas maksimal antrean + kebijakan drop saat outage panjang.
    this.maxDepth = parseInt(process.env.WA_SEND_MAX_DEPTH || '100', 10);
    this.droppedCount = 0;
    // REVIEW-FIX TASK-107: socket di-resolve lazy agar tahan reconnect Baileys.
    this._sockProvider = null;
  }

  /**
   * Daftarkan provider socket SEKALI di index.js:
   *   sendQueue.setSockProvider(() => sock);
   * Dengan ini, pesan yang di-enqueue SEBELUM reconnect tetap dikirim memakai
   * socket TERBARU (bukan referensi socket lama yang sudah mati).
   */
  setSockProvider(fn) {
    this._sockProvider = fn;
  }

  enqueueMessage(sock, jid, message, options = {}) {
    return new Promise((resolve, reject) => {
      // REVIEW-FIX: drop tegas bila antrean penuh — mencegah pertumbuhan tak
      // terbatas saat socket down lama; caller menangani via .catch().
      if (this.queue.length >= this.maxDepth) {
        this.droppedCount++;
        console.error(`[SendQueue] 🗑️ Antrean PENUH (depth=${this.queue.length}, max=${this.maxDepth}) — pesan ke ${jid} DITOLAK (total dropped=${this.droppedCount})`);
        reject(new Error(`SendQueue penuh (max ${this.maxDepth}) — pesan ditolak`));
        return;
      }
      this.queue.push({
        sock,
        jid,
        message,
        options,
        resolve,
        reject,
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
      // REVIEW-FIX: lazy sock — utamakan socket terbaru dari provider; fallback
      // ke referensi yang diberikan saat enqueue (backward compatible).
      const activeSock = this._sockProvider ? this._sockProvider() : task.sock;
      if (!activeSock) {
        console.error(`[SendQueue] ❌ Socket belum tersedia untuk ${task.jid} — pesan dibatalkan.`);
        task.reject(new Error('Socket tidak tersedia'));
        continue;
      }
      try {
        const result = await activeSock.sendMessage(task.jid, task.message, task.options);
        task.resolve(result);
      } catch (err) {
        console.error(`[SendQueue] ❌ Error sending message to ${task.jid}:`, err.message);
        task.reject(err);
      }

      // Hanya delay jika masih ada antrean berikutnya
      if (this.queue.length > 0) {
        // REVIEW-FIX: rentang jitter 300..WA_SEND_JITTER_MS sesuai spesifikasi task.
        const jitterMin = Math.min(300, this.jitter);
        const currentJitter = jitterMin + Math.floor(Math.random() * Math.max(0, this.jitter - jitterMin));
        const waitTime = this.minInterval + currentJitter;
        console.log(`[SendQueue] ⏳ Waiting... delay=${waitTime}ms (depth=${this.queue.length})`);
        await delayMs(waitTime);
      }
    }

    this.isProcessing = false;
  }
}

// Export singleton instance
module.exports = new SendQueue();
