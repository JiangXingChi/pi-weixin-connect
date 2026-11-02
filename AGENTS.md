# pi-weixin-connect · Agent Handbook

微信 ClawBot（iLink）⇄ 当前 Pi 会话的桥接插件。计划与验收以 `PLAN.md` 为准。

## 目录

```
src/          扩展实现（零运行时依赖）
scripts/      login.mjs：扫码登录 CLI
test/         mock iLink + 单测（node:test）
data/         预留
output/       预留
review/       预留
tmp/          临时产物（二维码、测试日志）
```

## 常用命令

```bash
node --test test/*.test.mjs        # 全部单测（34 项）
node scripts/login.mjs [--force]   # 扫码登录，凭证写 ~/.pi/agent/.pi-weixin/credentials.json
node --check src/index.js          # 语法检查
```

在 Pi 里：`/wx status`、`/wx login`、`/wx start`、`/wx stop`、`/wx logout`、`/wx log [n]`。
独立服务（默认）：`service.mode = "standalone"`，插件在任意 Pi 进程里加载时会自动拉起 `bin/pi-weixin-connect.mjs`；
systemd 单元用 `scripts/install-service.sh` 安装，日志 `~/.pi/agent/pi-weixin-connect.service.log`。

二维码默认落 `/tmp/pi-weixin-connect/qr.png`（0600，登录成功即删）；入站文件落
`/tmp/pi-weixin-connect/files/`。不要放 `~/.pi/agent`，pi-qq-connect 会按敏感路径拒发。

## 环境事实（已核实）

- iLink 基座：`https://ilinkai.weixin.qq.com`；CDN：`https://novac2c.cdn.weixin.qq.com/c2c`。
- 回复必须带该用户入站消息的 `context_token`；24 小时无新用户消息即失效。
- Bot 连续发送 10 条后会被阻断（默认预算 9），用户回复任意内容后重置。
- 微信不渲染 Markdown；文本按 4000 字符分片。
- 协议文档：`Tencent/openclaw-weixin` 的 `docs/protocol_zh_CN.md`（MIT）。
- 本机 `qrencode` 可用，二维码用 `qrencode -t ANSIUTF8` / `-t PNG` 生成。

## 约定

- 不往 `~/.pi/agent/` 放临时产物；二维码、入站文件放 `/tmp/pi-weixin-connect/`。
- `review/` 保留每轮审改记录；修改后必须重跑 `node --test`。
- 凭证文件必须 0600；日志里 token 只留前 6 位。
- 不实现群聊、主动推送、语音合成（见 PLAN 非目标）。
