# 第 8 轮审改（2026-11-09）

范围：第 7 轮修复后的全部代码。先核对第 7 轮 11 项，再重新找问题。

## 第 7 轮修复核对

| 项 | 状态 |
|---|---|
| 1 quiet start 漏加载配置 | 已修（quiet start 仍走 `start()`，只压 notify） |
| 2 空 200 热轮询 | 已修（`getUpdates` 拒绝空对象/空数组） |
| 3 标记降级汇总/空路径 | 已修（一条汇总；正文提示不再出现 `?`） |
| 4 围栏语言标签无上限 | 已修（截断 20 字符） |
| 5 服务识别与状态文件 pid 绑定 | 已修（只信任 env + ppid） |
| 6 deferred 绕过上限 | 已修 |
| 7 launcher stdin EPIPE | 已修（挂 error 处理器） |
| 8 服务日志 0644 | 已修（新建 0600） |
| 9 `message_id === 0` 去重 | 已修（0 走内容回退键） |
| 10 status 过期“未登录” | 已修（状态报告重读凭证） |
| 11 事件对象缺省 | 已修（可选链） |

## 本轮新发现

1. **【中】重新扫码时，二维码状态轮询用了凭证里保存的旧 `baseUrl`。**
   `login()` 里 `let baseUrl = existing?.baseUrl || api.baseUrl`。第 6 轮开始 `credentials.baseUrl`
   真正用于 Bot 请求后，这个值可能是上一次登录的 IDC 重定向主机；若该主机已失效，
   新二维码的状态轮询会连续失败 5 次直接退出。协议文档明确：二维码登录从固定 API 地址开始，
   重定向只用于本次轮询。→ 改为 `let baseUrl = api.baseUrl`，仅 `scaned_but_redirect` 时切换。
2. **【低】`startService` 把调用方的 `PIWXCONNECT_SERVICE_PID` 带进新 launcher。**
   嵌套启动时新 launcher 的 pi 的 `ppid` 是新 launcher，但 env 里是旧 pid，
   `isServiceProcess()` 会判 false，可能再多拉一层服务。→ spawn 前删掉该变量。
3. **【低】`scripts/login.mjs` 的 `channel_version` 写死 `0.1.0`。**
   包版本升级后与 `index.js` 不一致。→ 和 `index.js` 一样读 `package.json`。
4. **【低】`/wx login` 成功后没有刷新 `state.config` / 清掉旧 `state.error`。**
   standalone 下 `start()` 不会重跑，`/wx status` 会一直显示旧配置和旧错误。→ 登录成功后同步。

## 验证

- `node --check` 全部通过。
- `node --test test/*.test.mjs` **44/44** 通过（本轮未新增测试：改动集中在登录/启动器参数，
  已有 auth mock、入口集成测试覆盖；轮询起始地址由代码路径直接体现）。
- `pi --mode rpc` + 临时配置的 `/wx status` 冒烟仍正常。
