# Migrasi WhatsApp Briefing ke ai-orchestrator

## Ringkasan
Briefing pagi WhatsApp yang sebelumnya dijalankan oleh `whatsapp-briefing.timer` + `scripts/whatsapp_briefing.py` (via WAHA) sekarang telah diintegrasikan ke dalam `whatsapp-bot-ai` (Baileys) dan `ai-orchestrator` (LangGraph).

## Arsitektur Baru

```text
[whatsapp-bot-ai/index.js]
        │ cron: 0 8 * * 1-5 (Senin-Jumat 08:00 WIB)
        ▼
[briefing.js] ──POST /api/v1/briefing──▶ [ai-orchestrator/main.py]
        │                                       │
        │                                       ▼
        │                              [graph.py: generate_briefing()]
        │                                       │
        │                                       ▼
        │                              LLM (Groq via get_llm)
        │                                       │
        │                                       ▼
        │                              Webhook ke /webhook/whatsapp
        │                                       │
        ▼                                       ▼
[whatsapp-bot-ai/index.js] ◀───────────────┘
        │
        ▼
[sock.sendMessage(BRIEFING_GROUP_JID)] ──▶ GREEN GARDEN GHS
```

## File yang Dimodifikasi/Dibuat

### whatsapp-bot-ai
- `briefing.js` — modul trigger briefing ke ai-orchestrator
- `index.js` — integrasi cron scheduler
- `package.json` — tambah dependency `node-cron`

### ai-orchestrator
- `main.py` — endpoint baru `POST /api/v1/briefing` + background task
- `graph.py` — fungsi `generate_briefing()` untuk generate konten

### Environment
- `.env` — tambah `BRIEFING_GROUP_JID` dan `BRIEFING_CRON`

## Konfigurasi Environment

```bash
BRIEFING_GROUP_JID=120363426109888899@g.us
BRIEFING_CRON=0 8 * * 1-5
```

## Langkah Manual yang Tersisa

1. **Nonaktifkan systemd timer lama** (butuh sudo password):
   ```bash
   sudo systemctl stop whatsapp-briefing.timer
   sudo systemctl disable whatsapp-briefing.timer
   ```

2. **Restart services** agar perubahan berlaku:
   ```bash
   sudo systemctl restart mcp-ai-orchestrator.service
   sudo systemctl restart whatsapp-bot-ai.service
   ```

3. **Verifikasi** endpoint briefing tersedia:
   ```bash
   curl -X POST http://localhost:8001/api/v1/briefing \
     -H "Content-Type: application/json" \
     -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
     -d '{
       "platform": "whatsapp",
       "user_id": "120363426109888899@g.us",
       "message": "GENERATE_MORNING_BRIEFING",
       "webhook_url": "http://localhost:3001/webhook/whatsapp",
       "sender_id": null,
       "sender_name": "Briefing Bot",
       "group_name": "GREEN GARDEN GHS"
     }'
   ```

## Pembersihan Konfigurasi WAHA Lama

Konfigurasi berikut sudah dihapus dari `.env` karena tidak lagi digunakan:

- `WHATSAPP_API_URL=http://localhost:3000` — URL WAHA lama
- `WHATSAPP_API_KEY=mcp_unified_secret` — API key WAHA lama
- `WHATSAPP_BRIEFING_RECIPIENT=6281343733332-1606811696@g.us` — Group JID format WAHA lama

Konfigurasi yang sekarang aktif:

```bash
WEBHOOK_PORT=3001
WEBHOOK_HOST=http://localhost:3001
WHATSAPP_RECIPIENT=6287871393744
BRIEFING_GROUP_JID=120363426109888899@g.us
BRIEFING_CRON=0 8 * * 1-5
USER_PHONE_NUMBER=625217973038
GROQ_API_KEY_BOT_WHATSAPP=...
WEBHOOK_SECRET=...
```

## Catatan Penting

- Timer lama (`whatsapp-briefing.timer`) sudah dinonaktifkan oleh script `setup_systemd.sh`.
- Briefing sekarang menggunakan model LLM `llama-3.1-8b-instant` via `GROQ_API_KEY_BOT_WHATSAPP`, sehingga prompt dan model terpusat di `ai-orchestrator`.
- Format pesan tetap mengikuti struktur: sapaan, jokes, ide brainstorming, dan motivasi.
- Pastikan hanya satu instance `whatsapp-bot-ai` yang berjalan untuk menghindari konflik Baileys.
