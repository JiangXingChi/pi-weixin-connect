#!/usr/bin/env bash
# 停止并移除微信独立后台服务（不删凭证与源码）。
set -euo pipefail

systemctl --user disable --now pi-weixin-connect.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/pi-weixin-connect.service"
systemctl --user daemon-reload
rm -f "$HOME/.pi/agent/pi-weixin-connect.service.json"
# 不删锁文件：可能还有 inline 进程正持锁轮询，删了会让第二个实例也拿到锁
echo "已移除 pi-weixin-connect.service"
