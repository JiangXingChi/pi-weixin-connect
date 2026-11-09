# PLAN — pi-weixin-connect（微信 ClawBot ⇄ 当前 Pi 会话）

> 立项日期：2026-11-02。本文件是唯一计划源；未获用户确认前不写实现代码。

## 0 一句话

把 `pi-qq-connect` 的形态（消息进当前 Pi 会话、回答回到聊天软件）原样搬到微信：
接入层换成微信官方 **iLink Bot API**（ClawBot），其余行为对齐 `pi-qq-connect@0.4.1`。

## 1 背景（已核实，能做的前提）

- 2026-03 微信上线 **ClawBot** 插件，底层是官方 **iLink（智联）协议**，域名 `ilinkai.weixin.qq.com`。
- 不走逆向：扫码登录 → 长轮询收消息 → HTTP 发回复，**不需要公网 IP / 回调地址**（与 QQ 的 WebSocket 网关同构）。
- 腾讯已开源参考实现 `Tencent/openclaw-weixin`（MIT，npm `@tencent-weixin/openclaw-weixin`），带 17KB 协议文档。
- 本机实测：`GET https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` 返回
  `{"qrcode":"...","qrcode_img_content":"https://liteapp.weixin.qq.com/q/...","ret":0}`，接口可达。
- 前置门槛（唯一不可控）：微信 App **8.0.70+**，且账号已开通 **ClawBot 插件**（官方灰度放量中，
  入口：我 → 设置 → 插件）。未开通则整个项目不可用。

## 2 已核实事实

### 2.1 接口（来自腾讯开源协议文档与官方包源码）

| 接口 | 方法 | 用途 |
|---|---|---|
| `/ilink/bot/get_bot_qrcode?bot_type=3` | POST | 取登录二维码（可带 `local_token_list`，最多 10 个旧 token） |
| `/ilink/bot/get_qrcode_status?qrcode=&verify_code=` | GET | 轮询扫码状态 |
| `/ilink/bot/getupdates` | POST | 长轮询收消息，服务端挂起 35s |
| `/ilink/bot/sendmessage` | POST | 发文本/媒体 |
| `/ilink/bot/getuploadurl` | POST | 取 CDN 上传参数 |
| CDN `POST <upload_full_url>` | POST | 上传 AES-128-ECB 密文，读响应头 `x-encrypted-param` |
| CDN `GET .../download?encrypted_query_param=` | GET | 下载密文 |
| `/ilink/bot/getconfig` | POST | 取 `typing_ticket` |
| `/ilink/bot/sendtyping` | POST | `status:1` 正在输入 / `2` 取消 |
| `/ilink/bot/msg/notifystart` `/notifystop` | POST | 通知后端上线/下线 |

关键协议点：

- 鉴权头：`Authorization: Bearer <bot_token>`、`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN: base64(随机 uint32)`。
- 每个请求体带 `base_info: { channel_version, bot_agent }`。
- **`context_token` 是回复的必要条件**：每条入站消息带一个，回复必须原样回传；按用户缓存、持久化、重新登录后清空。
- 游标：`get_updates_buf` 不透明，每次响应更新；首次传空串；只能前进，不能重放。
- 扫码状态机：`wait → scaned → confirmed`，另有 `expired`、`need_verifycode`（手机显示数字配对码）、
  `verify_code_blocked`、`scaned_but_redirect`（换 `redirect_host` 继续轮询）、`binded_redirect`（已绑定，直接复用本地凭证）。
- 错误：`ret/errcode = -14` = 会话过期。官方客户端处理是**暂停该账号 1 小时**后重试；重新登录需再扫码。
- 文本上限：官方实现按 **4000 字符**分片；社区 SDK 亦为 4000。
- 媒体：`media_type` 1 图片 / 2 视频 / 3 文件 / 4 语音；AES-128-ECB + PKCS#7；
  `aes_key` 有三种编码（base64 原始 16 字节 / base64(hex) / 直接 hex），解码时都要兼容；
  上传固定 `no_need_thumb: true` 可不传缩略图；发送时把说明文字和媒体拆成两条消息。
- 消息项类型：1 文本 / 2 图片 / 3 语音 / 4 文件 / 5 视频 / 11 tool_call_start / 12 tool_call_result。
- 微信群聊：协议类型里有 `group_id`，但官方实现 `groupPolicy: "disabled"`，**只支持单聊**。

### 2.2 硬限制（官方文档未写，社区一致实测；项目按此设计，P0 再验证）

| 限制 | 内容 | 对本项目的影响 |
|---|---|---|
| 24 小时窗口 | `context_token` 约 24h 过期；超过 24h 没有新的用户消息，Bot 无法再发 | 长任务、定时推送会失败；必须提示用户先发一条消息 |
| 连续 10 条 | Bot 连发 10 条后，用户不回复则第 11 条被阻断；用户回任意内容后计数重置 | 回复预算设 9 条，超出截断并提示 |
| 无 Markdown | 微信不渲染 Markdown | 默认纯文本；标题/强调剥离，代码块保留原样 |
| 无「正在输入」自动态 | 需 `getconfig` + `sendtyping` 两次调用 | 每条用户消息单独取/缓存 ticket |
| 不做主动推送 | 没有用户消息就没有 token | 与 QQ 一样只做被动回复 |

### 2.3 信息来源

- 腾讯官方仓库协议文档：`github.com/Tencent/openclaw-weixin` → `docs/protocol_zh_CN.md`（已通读）。
- 官方实现：npm `@tencent-weixin/openclaw-weixin@2.4.10`（已解包核对 `src/api`、`src/auth/login-qr.ts`、`src/messaging/send.ts`）。
- 社区协议整理：`wechatbot.dev/zh/protocol`（端点、AES 三种密钥格式、错误码）。
- 社区实测：`openilink.com/docs/guide/background`（24h 窗口、ClawBot 依赖）、V2EX 多个 iLink 项目讨论（10 条限制、-14）。
- 已有 pi 侧实现（仅作对照，不直接依赖）：
  - `pi-wechat@0.1.0`：只做文本，媒体转占位，无锁/服务/命令。
  - `pi-weixin-bridge@1.7.4`：独立守护进程 + pi SDK 会话，**不是**绑定当前会话。

## 3 目标

对齐 `pi-qq-connect@0.4.1` 的行为：

1. 微信单聊消息进入**当前 Pi 会话**，回答发回微信；串行队列，保证一问一答不乱序。
2. 入站文本、图片（作为 Pi 图片输入）、语音转写文本；出站文本分片、`[[file:...]]` 文件/图片（最多 3 个）。
3. 微信里可用桌面命令：`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help`。
4. 插件自身命令：`/wx status|login|logout|start|stop|take|log`。
5. 单实例锁、后台常驻（`pi --mode rpc` + systemd 用户单元）、心跳与崩溃重拉。
6. 会话切换（`/new`、reload、fork）后桥自愈，不出现「桥已死」。
7. 扫码凭证持久化（0600），重启免扫码；`-14` 时明确提示需要重新扫码。

## 4 非目标

- 不做群聊（官方只支持单聊）。
- 不做主动/定时推送（受 24h 窗口限制）。
- 不做语音合成发送（Silk 编码仅解码转写，不生成语音）。
- 不做多微信账号同时在线（单账号，锁保证）。
- 不改微信协议、不做逆向、不使用非官方 hook。
- 不接管 `~/.pi-weixin` 之外的状态；不写用户主目录散文件（缓存放项目 `tmp/` 或 `~/.pi/agent`）。

## 5 架构

```
pi-weixin-connect/
├── index.js                 # Pi 扩展入口，注册命令/事件
├── src/
│   ├── config.js            # 配置读取/校验（~/.pi/agent/pi-weixin-connect.json）
│   ├── log.js               # 文件日志 + 脱敏
│   ├── auth.js              # 扫码登录、凭证持久化、-14 处理
│   ├── api.js               # iLink HTTP 封装（头、base_info、重试、游标）
│   ├── gateway.js           # 长轮询循环（35s、退避、notifyStart/Stop）
│   ├── text.js              # 纯文本化、4000 分片、文件标记解析、脱敏
│   ├── media.js             # AES-128-ECB、CDN 上传/下载、类型判定、上限
│   ├── session.js           # 队列、去重、忙碌跟踪、注入、回复预算、24h 窗口
│   ├── commands（暂内联 index.js）# /wx；桌面命令映射留到 P1 抽出
│   ├── lock.js              # 单实例锁 + 看门狗
│   └── index.js             # 组装：事件、桥、服务状态
├── bin/pi-weixin-connect.mjs # 常驻启动器（pi --mode rpc + 心跳 + 重拉）
├── packaging/pi-weixin-connect.service
├── test/                    # mock iLink + 单测 + e2e
├── data/ output/ review/ tmp/
├── PLAN.md
└── AGENTS.md
```

复用与重写（对照 pi-qq-connect）：

| 直接复用（改字段/删 QQ 概念） | 重写 |
|---|---|
| 队列、去重、忙碌跟踪、注入串行化（`session.js` 骨架） | 鉴权：扫码 + 配对码 + redirect |
| 文本分片、文件标记、日志脱敏（`text.js`） | 收消息：长轮询 + 游标（替代 WebSocket） |
| 单实例锁、服务状态、心跳（`lock.js`、`service.js`） | 回复：`context_token` + 10 条配额 + 24h 窗口 |
| 命令映射与 `/help` 文案（`commands.js`） | 媒体：CDN + AES（QQ 是 multipart 直传） |
| 扩展事件接线与切换自愈（`index.js` 骨架） | 错误模型：`-14` 暂停/重登 |

## 6 行为规格

### 6.1 登录

- `/wx login`：取二维码 → 终端 ANSI 渲染（本机有 `qrencode`；无则打印 URL）→ 轮询状态。
- 支持 `need_verifycode`：提示输入手机上的数字，重试；`verify_code_blocked` 重新取码。
- 成功后写 `~/.pi/agent/.pi-weixin/credentials.json`（0600，原子写）：
  `{ bot_token, bot_id, user_id, base_url, saved_at }`。
- `/wx logout`：删除凭证、停止轮询。
- 启动时若有凭证，直接 `getupdates`；`-14` 则暂停 1 小时并提示重新登录（失败不静默）。

### 6.2 收消息

- `getupdates` 挂起 35s；`longpolling_timeout_ms` 优先；连续 3 次失败退避 30s。
- 只处理 `message_type=1`（用户）且 `from_user_id` 在白名单内。
- 去重：`message_id` + `create_time_ms`，TTL 10 分钟。
- 归一化：文本拼接所有 `text_item`；图片取 `image_item` 的 CDN 引用下载解密（≤2 张 / 8MB，超出降级为占位）；
  语音优先用 `voice_item.text` 转写；文件记录 `file_name`/`len`，下载到 `tmp/` 后把路径告诉模型。
- 忽略自己发出的消息（`message_type=2`）与 `message_state != 2` 的中间态。

### 6.3 队列与注入

- 单队列串行：Pi 空闲才注入下一条（`agent_start` / `agent_settled`）。
- 注入失败（streaming/会话切换）→ 2s、5s、15s 退避重试，仍失败则暂存并提示。
- 会话切换（`new`/`reload`/`fork`）：暂停注入，保留队列，新实例接棒后恢复（对齐 QQ 0.4.1 的 adopt 机制）。

### 6.4 回复

- 只取最终 assistant 文本（`agent_settled` 后），中间工具输出不发。
- 纯文本化：剥离 `#`/`**` 标记，保留代码围栏内容；单条 ≤4000 字符，按段落/换行/空格切分。
- 每条入站消息回复预算 **9 条**（留 1 条余量），超出追加一行「（还有内容，回复任意消息继续）」。
- 每条回复必须带该用户的 `context_token`；token 缺失或过期 → 不发送，提示「请在微信里先发一条消息」。
- 24h 窗口：按用户记录最近入站时间；超过 24h 发送前直接拒绝并提示，不发无效请求。
- 输入状态：agent 开始 `status:1`，结束 `status:2`；ticket 按用户缓存 24h。

### 6.5 媒体

- 出站：解析回复中的 `[[file:/abs/path]]`（最多 3 个），校验白名单目录与大小
  （图片 20MB / 视频 30MB / 文件 200MB），AES + `getuploadurl` + CDN 上传，再发送媒体项。
- 出站图片：`media_type=1`，`no_need_thumb=true`；文件：`media_type=3`，带 `file_name`。
- 上传失败重试 3 次（4xx 立即失败），失败降级为文字说明。
- 入站图片：下载 → 解密 → base64 作为 Pi 图片输入；失败降级为 `[图片下载失败]`。

### 6.6 命令

- 本插件：`/wx status|login|logout|start|stop|take|log`（`start/stop/take` 终端执行）。
- 桌面命令（命中不进模型）：`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help`。
- 其余 `/xxx`（技能、模板、其他扩展命令）按普通文本交给 Pi。
- 微信不支持斜杠命令拦截，因此命令全部由插件自行解析（对用户透明）。

### 6.7 锁与服务

- 锁文件 `~/.pi/agent/pi-weixin-connect.lock` 存 pid + 启动时间；第二实例不抢轮询，`/wx take` 强制接管。
- `bin/pi-weixin-connect.mjs`：启动 `pi --mode rpc --session-id pi-weixin-connect-service`，
  写 `~/.pi/agent/pi-weixin-connect.service.json`（pid、版本、心跳），每 15s 心跳；退出后自动重拉（可 `--no-restart`）。
- systemd 用户单元示例；`ExecStart` 指向 npm 安装路径，不写死开发目录。
- 状态文件 45s 无心跳视为掉线，插件自动接管或提示 `/wx start`。

### 6.8 安全

- 默认白名单 = 扫码登录的 `ilink_user_id`；其他用户默认拒绝（不发任何内容）。
- 凭证、日志中的 token 脱敏（只留前 6 位）；日志 0600。
- 出站文件只允许配置的白名单目录（默认 `~`、项目目录、`tmp/`），拒绝 `/etc`、`/proc`、`.ssh` 等。

## 7 分阶段实施

### P0 通道打通（先做，1~2 天）

1. `config.js`、`log.js`、`api.js`、`auth.js`：扫码登录 + 凭证 + `getupdates` + `sendmessage`。
2. `session.js` 最小版：串行队列、去重、注入、回复。
3. `/wx status|login|logout` 命令 + 单实例锁。
4. **验收**：手机微信给 Bot 发「你好」，Pi 回复到达；连发 3 条不乱序；重启后免扫码。

### P1 完整行为（对齐 QQ 0.4.1）

1. 文本分片、预算 9 条、24h 窗口、typing。
2. 桌面命令映射（含 `/new` 切换与自愈）。
3. 服务化：`bin` 启动器 + systemd + 心跳 + 崩溃重拉。
4. **验收**：`/new` 后仍能收发；`/model` 切换生效；杀进程后 30s 内自动恢复。

### P2 媒体

1. 入站图片/文件/语音转写。
2. 出站 `[[file:...]]`：AES + CDN 上传 + 失败降级。
3. **验收**：微信发图被 Pi 正确识别；Pi 回复里带 `[[file:/path]]` 能在微信收到原文件。

### P3 发布

1. `README.md`、`docs/PROTOCOL-NOTES.md`（把上面已核实事实固化）、`CHANGELOG.md`。
2. `npm test` + mock e2e + 真实微信手工验收。
3. GitHub 仓库 + tag；npm 发布（**需用户单独确认**）。

## 8 测试

| 层 | 内容 |
|---|---|
| 单测 | 配置校验、4000 分片、文件标记、AES 三种密钥格式、去重、配额、24h 判定、脱敏 |
| 集成 | mock iLink HTTP：二维码状态机（wait/scaned/need_verifycode/confirmed/expired/redirect）、长轮询、sendmessage 断言、-14 |
| 端到端 | 真 `pi --mode rpc` + mock iLink：发「只回复 pong」，断言收到含 pong 的 sendmessage 且带正确 context_token |
| 真机 | 用户手机微信扫码 + 收发文本/图片/文件；记录 10 条配额与 24h 的实际表现 |

## 9 风险与回退

| 风险 | 处置 |
|---|---|
| 账号没有 ClawBot 插件（灰度） | P0 第一步就扫码验证；不可用则停止项目，不写后续代码 |
| iLink 协议变更（无公开契约） | 协议层集中在 `api.js`；出问题只改一处；文档留档 |
| `-14` 频繁、需反复扫码 | 凭证持久化 + 明确提示；不做无限重登 |
| 10 条配额/24h 窗口与社区描述不一致 | P0 实测记录；配额与窗口做成配置项 |
| 媒体上传失败/格式不支持 | 降级为文字 + 路径提示；不阻塞文本通道 |
| 会话切换把桥搞死 | 复用 QQ 0.4.1 的 adopt 机制 + 回归测试 |
| 微信版本不满足 8.0.70 | 启动时提示升级；不尝试绕过 |

## 10 待用户确认

1. 项目名/包名：**已定 `pi-weixin-connect`**（2026-11-02 核查：npm registry 404、GitHub 全站搜同名 0 条、`JiangXingChi/pi-weixin-connect` 不存在）。
2. 仓库归属：沿用 `JiangXingChi/pi-weixin-connect`（推荐）／新建组织。
3. 是否发布 npm：先只本地用（推荐，稳定后再发）／P3 直接发布。
4. 默认回复预算：**9 条**（10 条限制留 1 条余量）／其他。
5. 是否要群聊：不做（官方不支持）。
6. P0 真机验证：已完成（扫码 + 文本端到端）。
7. P2 与 P1 顺序：用户选择先做 P2（媒体），P1 顺延。

用户确认后，按 P0 → P1 → P2 → P3 顺序执行；每阶段完成即按 PLAN 验收，不擅自加功能。

---

## 11 执行记录

### P0 通道打通 — 完成（2026-11-02）

| 项 | 结果 |
|---|---|
| 代码 | `index.js`、`src/{config,log,api,auth,gateway,text,lock,session,index}.js`、`scripts/login.mjs`；零运行时依赖 |
| 测试 | `node --test test/*.test.mjs` 13/13 通过：消息归一化、白名单、4000 分片、扫码状态机（含配对码/封禁）、去重、9 条预算、24h 窗口、-14 |
| 加载 | `pi --mode rpc --no-extensions -e ./index.js` 实测 `/wx` 注册成功，stderr 为空 |
| 真机登录 | 扫码成功：`bot=83b2d2…@im.bot`、`user=o9cq80…@im.wechat`；凭证 `~/.pi/agent/.pi-weixin/credentials.json`（0600） |
| 端到端 | 微信发「你好」→ 05:38:20 注入 Pi → 05:38:25 回复 1 条到微信（同一条 Pi 会话，工具可用） |

### 与计划的偏差

- P0 未做服务化与 `/wx start|stop|take`（按计划属于 P1）。
- 二维码最初落在 `~/.pi/agent/.pi-weixin/qr.png`，发送到 QQ 时被 pi-qq-connect 判为敏感路径拒绝；改放项目 `tmp/qr.png`。
- 端到端验证用独立的 `pi --mode rpc` 临时进程，未写入 `settings.json`，避免打断当前 QQ 服务；验证后已停止，锁文件已清理。
- 回复预算、24h 窗口只做了单测；10 条配额与 24h 的真实边界仍待 P1 真机观察。

### P1 进展（2026-11-02，独立服务已完成）

- [x] `bin/pi-weixin-connect.mjs` 常驻启动器 + 15s 心跳 + 崩溃重拉（3s→60s 退避）
- [x] `src/service.js`：状态文件、存活判定、启动/停止、服务进程识别
- [x] `scripts/install-service.sh` / `uninstall-service.sh` + `packaging/*.service`
- [x] 默认 `service.mode = "standalone"`：任何 Pi 进程加载插件时自动拉起独立服务，自己只当控制面
- [x] `/wx start|stop`、`/wx status` 服务行、登录后自动重启服务、logout 停服务
- [x] 真机：QQ 服务与微信服务并行，QQ 侧日志确认“后台服务在线（pid …），本进程不连长轮询”
- [ ] 桌面命令映射：`/new` `/model` `/thinking` `/compact` `/session` `/name` `/tools` `/help`
- [ ] 会话切换（`/new`、reload、fork）自愈回归测试
- [ ] 发布 npm（用户先用几天再定）

### 顺序调整（2026-11-02，用户指令）

用户选择先做 **P2 媒体**、后做 P1。理由未说明；以下按 P2 → P1 执行，P1 内容不变。

### P2 媒体 — 完成（2026-11-02）

| 项 | 结果 |
|---|---|
| 入站 | 图片 CDN 下载 + AES 解密 + base64 作为 Pi 图片输入；文件下载到 `/tmp/pi-weixin-connect/files` 并把路径交给模型；语音用 `voice_item.text` 转写 |
| 出站 | `[[file:...]]`（≤3 个）→ MD5/尺寸 → `getuploadurl` → AES-128-ECB → CDN POST → `x-encrypted-param` → `sendmessage`（image/file/video） |
| 限制 | 图片 20MB / 视频 30MB / 文件 200MB；敏感路径与符号链接拒绝；失败降级为一条文字说明 |
| 测试 | 媒体/桥/服务共 34 项全过（AES 三种密钥、文件标记、上传/下载、入站图片、出站文件、重试、typing、切换暂存） |
| 待验 | 真机发图 / 真机收文件（需要用户在微信里操作，代码与 mock 已验证，尚未做真机媒体回归） |

### 多轮审改

- 第 1 轮：17 项缺陷（含 `onAgentSettled` 卡死、typing 不收敛、发送无重试、logout 不释放锁、敏感目录/软链绕过、去重键、配置布尔值等），全部修复。
- 第 2 轮：复核第 1 轮 + 新发现 8 项（无限重试、typing 竞态、RPC input 挂死、stop/切换期间注入、429 不重试等），全部修复。
- 第 3 轮：新发现 8 项（typing 收尾竞态、切换无看门狗、发送循环不看 stopped、二维码轮询无上限、redirect 取码、文件名注入、缺密钥文件、文档漂移），全部修复。
- 第 4 轮：新发现 4 项（准备阶段异常丢消息、看门狗无限重投、登录备份回滚时机、默认出站白名单与 PLAN 不一致），全部修复。
- 第 5 轮：完整复读 + 30 项测试 + `/wx status` RPC 冒烟，零发现，收敛。明细见 `review/round-1.md` … `review/round-5.md`。

- 第 6 轮：把新增的独立服务代码纳入审改；修 22 项缺陷（超时失效、非 JSON 热轮询、
  `baseurl` 未生效、文件标记降级、服务自识别、systemd 回退、二维码落日志等），
  新增 9 项回归测试。明细见 `review/round-6.md`。

- 第 7 轮：复核第 6 轮 22 项，新发现 11 项（quiet start 漏加载配置、空 200 热轮询、
  标记降级汇总、围栏语言标签、服务识别、deferred 上限、launcher EPIPE、日志权限等），
  全部修复；新增入口集成测试，`node --test` **44/44** 通过。明细见 `review/round-7.md`。

- 第 8 轮：复核第 7 轮 11 项，新发现 4 项（重新扫码误用旧 `baseUrl`、launcher 环境变量继承、
  CLI 版本写死、登录后配置/错误不刷新），全部修复。
- 第 9 轮：复核第 8 轮 4 项，新发现 4 项（心跳过期但进程存活时，登出/登录/启动会留下
  双服务或旧 token 继续轮询），全部修复；新增心跳过期集成测试，`node --test` **45/45** 通过。
- 第 10 轮：复核第 9 轮 4 项，新发现 2 项（`start()` 早退路径与异常路径会把长轮询锁留在
  已停止轮询的进程里），全部修复。
- 第 11 轮：完整复读协议、登录、消息、队列、服务、锁、安全与文档；`node --test` **45/45**
  通过，`git diff --check` 干净，RPC 冒烟正常，**零发现，收敛**。明细见 `review/round-6.md`
  … `review/round-11.md`。
