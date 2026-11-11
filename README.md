# pi-weixin-connect

> **Platform: Linux only.** The background service is a systemd *user* unit
> (`systemctl --user`). macOS and Windows are neither tested nor supported.

Bridge **WeChat ClawBot** (Tencent iLink bot protocol) to the **current Pi session**.
Messages sent in WeChat reach your Pi session; the final answer is sent back to WeChat.
Same idea as [pi-qq-connect](https://github.com/JiangXingChi/pi-qq-connect), for WeChat.

## Features

- QR login (pairing code, IDC redirect, credentials stored `0600`), no re-scan after restart
- Long polling; messages are injected into the current Pi session with a serial queue,
  deduplication, and hand-over on session switches
- Plain-text replies, 4000-char chunks, at most 9 chunks per message
- 24-hour window detection: explicit notice instead of silently dropping replies
- Inbound images (CDN download + AES-128-ECB) and files (saved under `/tmp`, path handed to the model)
- Outbound files via `[[file:/absolute/path]]` in a reply (max 3)
- Background service under systemd; startup is silent, errors carry a stable `[WX_E_*]` code

## Requirements

- WeChat 8.0.70+ with the ClawBot plugin enabled
- Node.js >= 22.19
- Pi >= 1.4
- Linux with systemd (user units)

## Install

```bash
pi install pi-weixin-connect
# or from a checkout
pi install /path/to/pi-weixin-connect
```

Restart Pi after installing.

## Login

```bash
/wx login
```

The QR image path is printed; scan it with WeChat. Credentials live in
`~/.pi/agent/.pi-weixin/credentials.json` (`0600`). If the login expires (`-14`), run
`/wx login` again.

## Commands

Terminal:

| Command | Purpose |
|---|---|
| `/wx status` | login, long polling, service, queue, budget |
| `/wx login [--force]` | QR login |
| `/wx start` / `/wx stop [--force]` | manage the background service |
| `/wx log [n]` | last n log lines (default 20) |
| `/wx help` | this list |
| `/wx logout` | delete credentials and disconnect |

In the WeChat chat window only `/new` is mapped: send it to start a new session.
Other control commands run in the terminal.

## Background service

```bash
bash scripts/install-service.sh
systemctl --user status pi-weixin-connect
```

The installer writes `~/.config/systemd/user/pi-weixin-connect.service` and enables it.
When the service is not running, the plugin starts it (`systemctl --user start` first,
detached spawn as fallback). Logs go to the journal, or to
`~/.pi/agent/pi-weixin-connect.service.log` for the fallback path.

## Limits

- Passive replies only within the 24-hour window that starts with your last message
- Ten outgoing messages per window are blocked by WeChat; the default budget is 9
- WeChat does not render Markdown; replies are sent as plain text

## License

MIT
