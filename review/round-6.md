# 第 6 轮审改（2026-11-09）

范围：前 5 轮之后的全部代码（含新增的 `src/service.js`、`bin/pi-weixin-connect.mjs`、
`scripts/install-service.sh`、`scripts/uninstall-service.sh`、`packaging/*.service`）、测试与文档。
参考：腾讯 `openclaw-weixin` 的 `docs/protocol_zh_CN.md`、`src/auth/login-qr.ts`、`src/api/api.ts`、
`src/monitor/monitor.ts`（2026-11 拉取），以及 Pi 1.5 的扩展 / RPC 文档。

方式：逐文件复读 + 针对可疑点写最小复现脚本（`tmp/probe*.mjs`）。以下只记问题。

## 协议 / 功能缺陷

1. **【高】传了外部 `signal` 后 `timeoutMs` 完全失效。**
   `src/api.js:66` `const controller = signal ? null : new AbortController()`；`gateway.js` 的
   `getUpdates` 总是带 signal，于是客户端超时从未生效。已复现：`timeoutMs=300`、服务端不响应，
   1.2 秒后请求仍挂起。后果：长轮询连接一旦被中间设备挂住，网关永久卡死，消息不再进来。
2. **【高】HTTP 200 + 非 JSON 响应被当成空成功。**
   `src/api.js:78` 解析失败时把 `data` 置 null，最后返回 `{}`；`getupdates` 会立刻返回空结果、
   客户端只睡 200ms 再请求，形成约 5 次/秒的热循环（门户页/反代 HTML 错误页即可触发）。
   已复现：返回 HTML 时 `getUpdates` 解析为 `{}`。
3. **【高】登录返回的 `baseurl` 存了却从不使用。**
   `auth.js` 把 `status.baseurl` 写入凭证，`index.js` 建 API 时却固定用
   `config.endpoints.base`。官方客户端用登录返回的 `baseUrl` 发后续 Bot 请求；IDC 重定向后
   本插件仍打默认域名，可能整条链路不可用。`credentials.baseUrl` 目前是死字段。
4. **【中】`files.enabled=false` 时 `[[file:...]]` 原样发给微信。**
   `session.js` 只在启用文件时才 `parseFileMarkers`，关闭时标记不剥离，直接把绝对路径发到聊天里。
   已复现：发送文本为 `给 [[file:/tmp/x.txt]] 你看`。
5. **【中】回复只剩被拒绝的文件标记时，用户收到的是沉默。**
   `parseFileMarkers` 把失败标记从正文里删掉，`skipped` 只写日志；正文变空后 `chunkText` 返回 []，
   一条消息都不发。已复现：回复 `[[file:/etc/passwd]]` → 0 条发送。与 PLAN「失败降级为文字说明」不符。
6. **【中】standalone 下 `/wx login` 成功后必定误报“网关没有启动”。**
   `index.js:416` `if (qrShown && !state.gateway)`；独立服务模式下控制面本来就没有 gateway，
   登录成功后仍会弹 warning。
7. **【中】`/wx start` 用的是进程启动时缓存的凭证。**
   `startBackground` 只检查 `state.credentials`。若用户先在本进程启动后再用
   `scripts/login.mjs` 扫码（README 推荐路径之一），命令会误报“还没有登录”。
8. **【中】standalone 下每次 `/new` 都会先报“正在重建微信连接”再报“服务在线”。**
   `session_start` 在 `!bridge && !gateway` 时无条件提示并调用 `start()`；服务本来就在跑，
   两条 notify 都是噪音且前一条是假警报。
9. **【中】systemd 不可用时没有回退。**
   `startManagedService` 只要 `~/.config/systemd/user/pi-weixin-connect.service` 存在就走
   `systemctl --user start`；容器 / 无 user bus / 残留 unit 时直接失败，不会退回 detached 启动。
10. **【中】服务进程识别完全依赖状态文件。**
    `isServiceProcess(svc)` 要求状态文件存在且 pid 对上。状态文件被删/损坏时，服务里的 Pi 会
    把自己当控制面，再拉起一个嵌套服务（原进程停轮询、新服务抢锁），留下两个 Pi。
11. **【低】分片会切断 emoji 代理对。**
    `splitFenced` / 截断用 `slice` 按 UTF-16 码元切；切点落在代理对中间时，前后两段各留半个字符。
    已复现：两段都含未配对代理。
12. **【低】`buildPrompt` 里“最多 3 个”写死。**
    `text.js:90` 不读 `cfg.files.maxCount`，配置改小/改大后提示与行为不一致。
13. **【低】“完整结果见 Pi 终端”在独立服务下是错的。**
    默认 standalone 没有可见终端，超长截断提示把用户指向一个不存在的地方。
14. **【低】敏感路径判断的两个硬编码。**
    `media.js:97` 家目录回退写成 `/home/teacat`；`DENY_PREFIXES` 含 `/root`，以 root 运行时
    等于整个家目录都被禁发。另有 `.git-credentials`、`.netrc`、`.npmrc`、`.aws`、`.docker`、
    `.kube` 等常见凭证文件不在拒绝名单里（纵深防御）。
15. **【低】二维码 ANSI 被永久写进日志。**
    `index.js:364` 把整幅二维码 `logger.info` 到 `~/.pi/agent/pi-weixin-connect.log`；
    登录成功后 PNG 删了，日志里的二维码还在，`/wx log` 也能把它打出来。与“登录成功即删”的设计矛盾。
16. **【低】`scripts/login.mjs` 已有凭证时仍会重新扫码。**
    脚本打印“要重新扫码请加 --force”，然后没有 return，继续走扫码流程（README 说不会重复扫码）。
17. **【低】`scripts/uninstall-service.sh` 无条件删锁文件。**
    若此时另有一个 inline 进程正持锁轮询，删锁会让第二个实例也能拿到锁，消息被随机分走。
18. **【低】入站文件名只清 `\r\n\t`。**
    `text.js` 的 `safeName` 不处理其他 C0/C1 控制字符（如 ESC），仍可污染 prompt 行。

## 卫生 / 文档

19. `src/index.js` 导入未使用的 `startService`；`scripts/install-service.sh` 计算了未使用的 `NODE`。
20. README 顶部仍写「P1（常驻服务 / systemd）尚未实现」，与已完成的独立服务矛盾；测试数仍写 30；
    安装示例路径仍在 `/home/teacat/Agent/Temp/`；`files.allowDirs` 描述成“放宽”，实际是“替换白名单”。
21. `packaging/pi-weixin-connect.service` 的 `ExecStart` 仍是旧的 `%h/Agent/Temp/pi-weixin-connect`。
22. 登录返回缺少 `ilink_user_id` 时静默成功，之后所有消息都会因“不知道 owner”被拒，没有任何提示。

## 记录但本轮不改（不是缺陷 / 需真机）

- `-14` 后不按官方暂停 1 小时重试，而是要求重新扫码：PLAN §3.7 的既定设计。
- `get_updates_buf` 不落盘：进程重启期间的消息不补拉（PLAN 已记录，P3 再定）。
- `/wx login` 没有取消入口（TUI 中扫码流程可长跑）：需要新增取消命令，超出本轮范围。
- 消息引用 `ref_msg` 不解析；`run_id` 不回传：当前只影响引用展示/流式关联，不影响收发。
- typing ticket 不设 TTL；官方有配置缓存，当前失败只影响“正在输入”。
- 出站文件默认白名单仍是“家目录 / cwd / tmp 减去敏感子目录”；Pi 本身有读文件工具，
  这不是对抗 prompt injection 的安全边界（第 5 轮已记录）。
