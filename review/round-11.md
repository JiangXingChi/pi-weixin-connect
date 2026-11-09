# 第 11 轮审改（2026-11-09）

范围：第 10 轮修复后的全部代码、测试与文档。目标：完整复读一遍，确认没有新缺陷后收敛。

## 第 10 轮修复核对

| 项 | 状态 |
|---|---|
| 1 `start()` 早退路径漏放锁 | 已修（配置错误 / 禁用 / 未登录 / 心跳过期四条路径均 `stop({release:true})`） |
| 2 `start()` 外层 catch 漏放锁 | 已修 |

## 本轮检查项

- **协议**：二维码取码/状态机（wait/scaned/redirect/need_verifycode/blocked/expired/binded）、
  `getupdates` 游标与 35s 长轮询、`sendmessage` 的 `context_token`/`message_type=2`/
  `message_state=2`、`getuploadurl` 字段、CDN AES-128-ECB + PKCS#7、`x-encrypted-param`、
  图片 `aeskey` 优先于 `media.aes_key`、文件/语音缺 key 跳过。
- **登录**：二维码固定从官方基座开始、IDC 重定向只影响本次轮询、`baseurl` 用于后续 Bot 请求、
  凭证 0600、`--force` 备份/回滚、已有凭证时 CLI 不重扫。
- **消息**：`message_type`/`message_state` 过滤、群聊忽略、去重键、白名单、24h 窗口、
  9 条预算、4000 字分片、Markdown 剥离、文件标记降级、入站图片/文件、文件名控制字符。
- **队列**：串行注入、看门狗 3 次上限、stale 暂停、切换看门狗、deferred 上限、stop 清理。
- **服务**：启动器单实例检查、心跳 15s/45s、状态文件原子写、systemd 回退、SIGTERM 转发、
  stdin EPIPE、日志 0600、服务自识别不依赖状态文件、心跳过期不双开。
- **锁**：硬链接原子抢锁、死 pid 接管、只释放自己的锁、看门狗让位、所有早退路径释放。
- **安全**：敏感路径/软链、默认白名单、`allowDirs` 语义、凭证/日志/token 脱敏、
  二维码不落持久日志。
- **文档/测试**：README、AGENTS、PLAN、packaging 与实现一致；45 项测试覆盖上述回归点。

## 验证

- `node --check src/*.js scripts/*.mjs bin/*.mjs index.js` 全部通过。
- `node --test test/*.test.mjs` **45/45** 通过。
- `git diff --check` 无空白错误。
- `pi --mode rpc --no-extensions --extension <repo>` + 临时配置：`/wx status` 正常，
  退出后无残留锁文件。
- 真机未回归项（图片/文件收发、10 条/24h 边界）仍按 PLAN 记录待验，不属于代码缺陷。

**结论：本轮零发现，审改收敛。** 第 6~11 轮累计修复 43 项缺陷，新增 11 项回归测试
（`test/round6.test.mjs` 9 项、`test/index.test.mjs` 2 项）。
