# 第 9 轮审改（2026-11-09）

范围：第 8 轮修复后的全部代码。重点复核后台服务的生命周期（进程 / 心跳 / 凭证三者不同步时）。

## 第 8 轮修复核对

| 项 | 状态 |
|---|---|
| 1 重新扫码用旧 `baseUrl` | 已修（状态轮询固定从 `api.baseUrl` 开始） |
| 2 `startService` 继承 `PIWXCONNECT_SERVICE_PID` | 已修（spawn 前删除） |
| 3 CLI `channel_version` 写死 | 已修（读 package.json） |
| 4 登录后不刷新 config/error | 已修 |

## 本轮新发现

1. **【中】`/wx logout` 只停“心跳新鲜”的服务。**
   `if (svc && isServiceAlive(svc))`。进程活着但心跳过期（事件循环卡住/被 SIGSTOP）时，
   登出会删凭证、却不杀服务；旧进程内存里的 token 仍然有效，会继续收发消息。
   → 改为 `isProcessAlive` 就停；停止失败则取消登出并提示 `/wx stop --force`。
2. **【中】standalone 下 `/wx login` 有同样的心跳门。**
   旧服务心跳过期但进程活着时不会被停，新服务启动后抢不到锁只能空转，新 token 不生效。
   → 改为按进程存活停止；停止失败则本次不重启服务并明确提示。
3. **【中】`/wx start` 在“进程活着 + 心跳过期”时会双开。**
   `startBackground` 只在心跳新鲜时报“已在运行”，随后直接 `startManagedService`。
   → 进程活着但心跳过期时拒绝启动，提示先 `/wx stop --force`。
4. **【中】`start()` 自动启动路径同样会双开。**
   `svcAlive` 为 false 就 `removeServiceState` + 启动新服务，旧进程仍在轮询。
   → 增加 `svcProcessAlive` 分支：置 error 状态并提示，静默启动（quiet）时只记状态不刷屏。

## 验证

- `node --check` 全部通过。
- `node --test test/*.test.mjs` **45/45** 通过。
- 新增 `test/index.test.mjs` 第二个用例：进程存活 + 心跳过期时，`session_start` 不双开、
  `/wx start` 拒绝启动；用临时配置与一个 `setTimeout` 占位进程模拟旧 launcher。
- `review/round-6.md` … `round-8.md` 的修复逐条复核无回退。
