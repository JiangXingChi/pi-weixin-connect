# pi-weixin-connect

> **平台要求：Linux**。后台服务通过 systemd 用户单元（`systemctl --user`）管理，
> 仅在 Linux 上验证；macOS / Windows 未支持。

把**微信 ClawBot**（腾讯 iLink Bot 协议）接到**当前 Pi 会话**的桥接插件。

微信里发的消息进入当前 Pi 会话，Pi 干完活后把最终回答发回微信；用法和
[`pi-qq-connect`](https://github.com/JiangXingChi/pi-qq-connect) 对齐，只是聊天软件换成微信。

> 状态：文本通道、媒体与独立后台服务已完成。聊天窗口里只映射 `/new`（技能与提示模板
> 仍可正常使用）；`/model` 等控制命令请在终端执行。
> 文本收发已在真机微信验证；图片/文件目前只有单元与 mock 验证，尚未做真机回归。

## 能力

- 扫码登录（配对码、IDC 重定向、凭证持久化 0600），重启免扫码
- 长轮询收消息，消息注入**当前** Pi 会话，串行队列、去重、切换会话后自动接棒
- 回复纯文本化、4000 字符分片、每条消息最多 9 段（微信连发 10 条会阻断）
- 24 小时窗口检测：token 过期时明确提示，不静默丢消息
- 入站图片：CDN 下载 + AES-128-ECB 解密，作为 Pi 图片输入
- 入站文件：下载到 `/tmp/pi-weixin-connect/files`，路径交给模型
- 出站文件：回复里写 `[[file:/绝对路径]]`（最多 3 个），自动做 AES 加密 + CDN 上传
- 输入状态、敏感路径/软链拒绝、单实例锁

## 前置条件

- 微信 **8.0.70+**，且账号已开通 **ClawBot 插件**（设置 → 插件；官方灰度放量中）
- Node.js **>= 22.19**
- Pi **1.4+**

没有 ClawBot 入口时，iLink 登录会失败，本项目不可用。

## 安装

已发布 npm（[`pi-weixin-connect`](https://www.npmjs.com/package/pi-weixin-connect)）：

```bash
pi install pi-weixin-connect
```

本地开发目录：

```bash
pi install /path/to/pi-weixin-connect
```

或在 Pi 里 `--extension /绝对路径/index.js` 临时加载。

## 登录

在 Pi 里：

```text
/wx login
```

也可以直接用命令行（二维码会打印在终端，同时保存 PNG）：

```bash
node scripts/login.mjs          # 已有凭证时不会重复扫码
node scripts/login.mjs --force  # 强制重扫，失败会回滚旧凭证
```

凭证位置：`~/.pi/agent/.pi-weixin/credentials.json`（0600）。
二维码默认写 `/tmp/pi-weixin-connect/qr.png`，登录成功即删除。

## 命令

| 命令 | 说明 |
|---|---|
| `/wx status` | 登录状态、长轮询、后台服务、队列、预算 |
| `/wx login [--force]` | 扫码登录（服务在跑时会自动重启服务） |
| `/wx start` | 启动独立后台服务（微信走自己的进程/会话） |
| `/wx stop [--force]` | 停止独立后台服务 |
| `/wx logout` | 删除凭证并断开 |
| `/wx log [n]` | 最近 n 条日志 |
| `/wx help` | 命令表 |

## 独立后台服务（推荐）

微信可以跑在**自己的** `pi --mode rpc` 进程里，和 QQ 服务互不影响：

```bash
scripts/install-service.sh          # 生成 ~/.config/systemd/user/pi-weixin-connect.service 并启动
systemctl --user status pi-weixin-connect
scripts/uninstall-service.sh        # 卸载（不删凭证）
```

默认 `service.mode = "standalone"`：**任何** Pi 进程加载插件时，都会自动拉起独立服务，
自己只做控制面，不会跟微信长轮询抢在一起。装了上面的 systemd 单元时，自动启动会走
`systemctl --user start`（日志进 journal、可开机自启）；没装时退回 detached 进程。

状态看 `/wx status` 的“后台服务”一行。服务日志：journal 或
`~/.pi/agent/pi-weixin-connect.service.log`。

微信里可以直接发 `/new` 开新会话（聊天窗口只映射这一条）；`/model` 等控制命令请在终端执行。

## 配置

可选文件：`~/.pi/agent/pi-weixin-connect.json`（不存在则全用默认值）。

```json
{
  "service": { "mode": "standalone" },
  "allowUsers": [],
  "typing": true,
  "maxChunks": 9,
  "sessionWindowHours": 24,
  "images": { "enabled": true, "maxCount": 2, "maxBytes": 8388608 },
  "files": {
    "enabled": true,
    "maxCount": 3,
    "maxBytes": 209715200,
    "allowDirs": []
  }
}
```

- 默认 `service.mode = "standalone"`：任何 Pi 进程加载本插件时，都只自动拉起独立后台服务，
  自己不当长轮询；想退回“挂在当前进程”的老行为，才改成 `"inline"`。
- `allowUsers` 为空 = 只允许扫码登录者本人；填入则按白名单。
- 出站文件默认只允许 `家目录 / 当前工作目录 / /tmp`，并始终拒绝 `~/.ssh`、`~/.config`、
  `~/.pi/agent`、`/etc` 等敏感路径。填写 `files.allowDirs` 后**只允许这些目录**（替换默认白名单）；
  敏感路径仍然拒绝。

## 微信侧限制（协议约束，无法绕过）

- **24 小时窗口**：超过 24 小时没有新的用户消息，`context_token` 失效，Bot 发不出去。
- **连续 10 条**：Bot 连发 10 条后，用户不回复会被阻断；本项目预算 9 条。
- **只支持单聊**：官方实现禁用群聊。
- **不渲染 Markdown**：默认按纯文本发送。
- 不做主动推送、不做语音合成、不做多账号。

## 开发

```bash
node --test test/*.test.mjs   # 45 项：文本/队列/扫码/媒体/网关/回归
node --check src/index.js
```

```
index.js                 Pi 扩展入口
src/config.js            配置
src/auth.js              扫码登录、凭证
src/api.js               iLink HTTP 封装
src/gateway.js           长轮询
src/text.js              归一化、分片、纯文本
src/media.js             AES-128-ECB、CDN 上传/下载、文件标记
src/session.js           队列、注入、回复预算、24h 窗口、typing
src/lock.js              单实例锁
scripts/login.mjs        命令行扫码登录
test/                    mock iLink + 单测
review/                  多轮审改记录
```

协议依据腾讯开源实现 [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin)
（MIT）的 `docs/protocol_zh_CN.md` 与官方 npm 包源码。

## License

MIT
