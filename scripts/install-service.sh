#!/usr/bin/env bash
# 安装并（默认）启动微信独立后台服务。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/pi-weixin-connect.service"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=pi-weixin-connect — 微信 ClawBot ⇄ Pi 独立服务
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/usr/sbin:/bin:/sbin
ExecStart=/usr/bin/env node $ROOT/bin/pi-weixin-connect.mjs --cwd $HOME --session-id pi-weixin-connect-service
Restart=on-failure
RestartSec=3
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

echo "已写入 $UNIT"
systemctl --user daemon-reload
systemctl --user enable pi-weixin-connect.service
if [ "${PIWXCONNECT_NO_START:-0}" != "1" ]; then
	systemctl --user restart pi-weixin-connect.service
	echo "已启动 pi-weixin-connect.service"
else
	echo "已启用（未启动）"
fi
