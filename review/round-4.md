# 第 4 轮审改（2026-11-02）

范围：第 3 轮修复后的最终代码 + 测试 + 文档。复读 `session.js` 全量、`index.js` 登录段、`media.js` 权限段、`auth.js` 全量。

## 第 3 轮修复核对

7 项全部落地；30/30 测试通过。

## 本轮新发现

1. **`#pumpOnce` 在“准备消息”阶段抛错会丢消息。** `queue.shift()` 之后、`inflight` 建立之前的 `#collectImages` / `#collectFiles` / `buildPrompt` 若抛异常，只有 `pump()` 的兜底 catch，而它拿不到 item；这条消息既没处理也没回队列。
   → 把准备阶段包进 try/catch：失败时回队首并退避重试。
2. **注入看门狗可以无限重投。** `!started` 分支有 3 次上限，但 `#armInjectWatchdog` 每次超时都直接回队列；Pi 一直不接手时会每 5 秒重注入一次。
   → 与 `!started` 共用 `item.attempts`，3 次后记失败丢弃。
3. **登录成功但网关启动失败时，凭证备份处理不对。** `dropCredentialsBackup` 在 `start()` 之前执行；`start()` 抛错时 catch 又去 `restoreCredentials`，把刚拿到的可用凭证换回旧备份。
   → 记录 `loggedIn`；只有扫码失败才回滚，扫码成功后的启动失败保留新凭证并清掉备份。
4. **出站默认白名单与 PLAN 不一致。** PLAN §6.8 写“默认 `~`、项目目录、`tmp/`”，实现是“除敏感路径外全放行”（`/opt`、`/mnt` 都能发）。
   → 默认限定 home、cwd、`os.tmpdir()`；要放宽写 `files.allowDirs`。

修复后 `node --test` 30/30 通过。
