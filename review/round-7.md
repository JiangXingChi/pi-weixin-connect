# 第 7 轮审改（2026-11-09）

范围：第 6 轮修复后的全部代码。先逐条核对第 6 轮的 22 项，再重新找问题，并做了一次
`pi --mode rpc` + 临时配置的 `/wx status` 冒烟。

## 第 6 轮修复核对

| 项 | 状态 |
|---|---|
| 1 外部 signal 吞掉 timeout | 已修（`AbortSignal.any` 合并；复现脚本 306ms 超时） |
| 2 200 + 非 JSON 当空成功 | 已修（2xx 非 JSON 抛 `ApiError`） |
| 3 `baseurl` 未生效 | 已修（`start()` 使用凭证 baseUrl；`safeBaseUrl` 校验） |
| 4 files 关闭时标记原样发出 | 已修（`parseFileMarkers({disabled})` 仍剥离） |
| 5 只剩失败文件标记时沉默 | 已修（追加“N 个文件未发送：原因”） |
| 6 standalone 登录后误报网关没启动 | 已修（仅 inline 提示） |
| 7 `/wx start` 用旧凭证缓存 | 已修（重新 `loadCredentials`） |
| 8 `/new` 重复报“正在重建” | 已修（在线服务走 quiet start） |
| 9 systemd 不可用无回退 | 已修（失败退回 detached） |
| 10 服务识别依赖状态文件 | 已修（信任 env + ppid） |
| 11 emoji 代理对被切断 | 已修（`safeCut`） |
| 12 “最多 3 个”写死 | 已修（读 `files.maxCount`） |
| 13 “完整结果见 Pi 终端” | 已修（改为“已截断”） |
| 14 HOME 回退与 `/root` 硬编码 | 已修（`os.homedir()`，移除 `/root` 整目录拒绝） |
| 15 凭证文件不在拒绝名单 | 已修（补 6 类） |
| 16 二维码 ANSI 落日志 | 已修（只记行数，debug 级） |
| 17 CLI 有凭证仍重扫 | 已修（直接退出） |
| 18 uninstall 删锁 | 已修（不再删） |
| 19 未使用变量/导入 | 已修 |
| 20 README 漂移 | 已修（状态、路径、测试数、allowDirs 语义） |
| 21 packaging 旧路径 | 已修（占位路径） |
| 22 缺 `ilink_user_id` 静默成功 | 已修（登录告警 + 配置提示） |

## 本轮新发现（含第 6 轮修复引入的问题）

1. **quiet start 把配置/凭证也跳过了。** 第 6 轮修 #8 时在 `session_start` 直接 `return`，
   控制面新进程如果服务已在跑，就再也不会加载 `state.config`/`state.credentials`，
   `/wx status` 显示“未加载/未登录”。→ 改为仍调用 `start(ctx,{quietService:true})`，
   只压掉“服务在线”的 notify。
2. **空 200 响应仍会热轮询。** 第 6 轮只处理了非 JSON；空 body 仍被 `#request` 变成 `{}`，
   `getupdates` 当空成功，200ms 一次。→ `getUpdates` 显式拒绝空对象/空数组；
   新增空响应回归测试。
3. **files 关闭时的 skipped 列表无上限，且路径为空时提示出现 `?`。**
   → 改为只记一条汇总（`文件发送已关闭（N 个）`），正文提示对空路径只显示原因。
4. **代码围栏语言标签长度无上限。** 超长 ```` ```lang ```` 会让每段前缀挤掉正文，
   极端情况下切出空片并空转。→ 语言标签截断到 20 字符。
5. **`isServiceProcess` 仍与状态文件 pid 绑定。** 另一个 launcher 覆盖状态文件后，
   老服务的 Pi 会认为“我不是服务”，再拉起第三个进程。→ 只信任 `PIWXCONNECT_SERVICE_PID`
   与 `process.ppid`。
6. **下载附件后进入 deferred 的路径绕过 `maxQueue`。** 第 1 轮只修了 `enqueue`。
   → 同一处也检查上限。
7. **launcher 的 `child.stdin` 没有 error 监听。** pi 先退出时写 `extension_ui_response`
   可能触发异步 EPIPE，弄死 launcher。→ 挂空 error 处理器。
8. **后台服务日志文件默认 0644。** 与“日志 0600”的约定不一致。→ `openSync(..., 0o600)`。
9. **`message_id === 0` 被当成有效去重键。** 服务端若用 0 表示“无 ID”，10 分钟内
   所有消息会互相去重。→ 0 按空处理，走内容回退键。
10. **`statusReport` 可能显示过期的“未登录”。** 进程启动后才用 CLI 扫码时，
    `state.credentials` 未更新。→ 状态报告重新读凭证。
11. **`message_end` / `agent_settled` 没有可选链。** 事件对象缺失时 handler 会抛异常。
    → `event?.message` / `event?.aborted`。

## 验证

- `node --check` 全部通过。
- `node --test test/*.test.mjs` **44/44** 通过（新增 10 项：超时、非 JSON、空响应、
  baseUrl 校验、代理对、maxCount 提示、files 关闭降级、只剩失败标记、入口集成）。
- `pi --mode rpc --no-extensions --extension <repo>` + 临时配置：`/wx status` 正常返回
  配置、凭证、长轮询、白名单、服务、预算、模型、会话；stderr 无异常。
