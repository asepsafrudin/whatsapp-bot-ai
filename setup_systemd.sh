#!/bin/bash
# Setup systemd services untuk whatsapp-bot-ai dan mcp-ai-orchestrator
# Jalankan dengan: sudo bash setup_systemd.sh

set -e

echo "=== Setup systemd services ==="

# Copy service files ke /etc/systemd/system/
cp /home/aseps/MCP/infrastructure/systemd/mcp-ai-orchestrator.service /etc/systemd/system/
cp /home/aseps/MCP/infrastructure/systemd/whatsapp-bot-ai.service /etc/systemd/system/

# Reload systemd
systemctl daemon-reload

# Nonaktifkan timer lama
systemctl stop whatsapp-briefing.timer || true
systemctl disable whatsapp-briefing.timer || true
systemctl stop whatsapp-briefing.service || true
systemctl disable whatsapp-briefing.service || true

# Enable dan start services baru
systemctl enable mcp-ai-orchestrator.service
systemctl enable whatsapp-bot-ai.service
systemctl restart mcp-ai-orchestrator.service
systemctl restart whatsapp-bot-ai.service

echo "=== Setup selesai ==="
echo ""
echo "Status service:"
systemctl status mcp-ai-orchestrator.service --no-pager
systemctl status whatsapp-bot-ai.service --no-pager