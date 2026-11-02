# 第 1 轮审改（2026-11-02）

范围：`index.js`、`src/*.js`、`scripts/login.mjs`、`test/*`、`package.json`、`PLAN.md`、`AGENTS.md`。
方式：只读通读 + 对照腾讯协议文档与 pi-qq-connect 0.4.1 的对应实现。以下只记问题，不改代码。

## 功能性缺陷

1. **`session.js` `onAgentSettled` 在 `!inflight.started` 分支没有清 `this.inflight`。**
   注释说“跳过”，实际把这个桥永久卡住：`pump()` 的守卫要求 `!this.inflight`，队列再也动不了（只能等 5 秒看门狗，若看门狗被关闭则永久卡死）。
2. **输入状态收不了尾。** 注入看门狗把消息放回队列、`#failOnStale`、`stop()` 都不调用 `#stopTyping`；微信端会一直显示“对方正在输入”。
3. **发送没有重试。** `sendText` / `sendItems` 遇到网络抖动或 5xx 直接抛错，`#finish` 记一条失败就丢掉整条回复（文件有 3 次重试，文本没有）。
4. **`/wx logout` 不释放锁。** `stop({ release:false })` 把锁文件留给一个还活着的进程，其他 Pi 实例会一直“被占用”，只能手动删文件。
5. **`/wx login --force` 先删凭证再扫码。** 扫码失败/取消后，原本可用的凭证已经没了，只能重新扫。
6. **二维码落在 `~/.pi/agent/.pi-weixin/qr.png`。** pi-qq-connect 把 `~/.pi/agent` 当敏感路径，QQ 里发不出这张图（本次实测已被拒一次）；且登录成功后不清理含登录票据的 PNG。
7. **队列在切换（deferred）期间没有上限。** `switching` 时 `enqueue` 直接 push，绕过 `maxQueue`。
8. **`gateway` 在空响应后按 `longpolling_timeout_ms`（35s）再睡一次。** 服务端已经挂起了 35s，客户端再睡 35s，最坏把新消息延迟到 70s。
9. **`start()` 没有 catch。** 任何异常（配置、凭证、fetch）都变成未处理的 Promise rejection；调用处是 `void start(ctx)`。

## 安全缺陷

10. **`isAllowed` 在 `allowUsers=[]` 且 `credentials.userId` 为空时返回 true**，等于放行所有人。
11. **`allowDirs` 非空时完全绕过内置敏感路径**：配置 `allowDirs:["~"]` 就能发 `~/.ssh/id_rsa`，与文档“敏感路径拒绝”矛盾。
12. **符号链接绕过**：`inspectFile` 用 `statSync` 跟随链接、用原路径做前缀判断，允许目录里的软链可以指向 `~/.ssh`。

## 正确性 / 边界

13. **去重键是 `message_id + create_time_ms`。** 同一 `message_id` 若服务端重投时时间戳变化会重复处理；`message_id` 已经足够。
14. **不检查 `message_state`。** 状态 1（生成中）的中间消息也会被当作用户消息注入。
15. **分片后缀可能越界。** `(i/n)` 是切完才加的，恰好 4000 字符的块会变成 4008；`INDICATOR_RESERVE` 只对切分路径生效。
16. **入站文件落盘用 `Date.now()` 前缀**，同一毫秒的两个文件会互相覆盖。
17. **配置布尔项不做类型转换。** `"enabled": "false"`（字符串）被当成 true；`typing`、`lock`、`images.enabled`、`files.enabled` 同理。

## 测试缺口

18. 没有覆盖：`!started` 恢复、typing 收尾、发送重试、logout 释放锁、`--force` 失败回退、敏感目录/软链、去重键、`message_state`、分片长度上限、deferred 上限。

## 记录但本轮不改（非缺陷 / 后续增强）

- 游标 `get_updates_buf` 不持久化：进程重启期间的消息不补拉。P3 再定。
- 入站 200MB 文件整体读入内存；当前上限沿用 QQ 配置，实际很少触发。
- 模型若在正文里复述 `[[file:...]]` 示例，会被当成真实发送指令；这是标记协议的固有风险（QQ 版相同）。
- 同一会话里若扩展被两个不同 `pi` 对象加载，两个实例都会注册 `/wx` 命令；pi 对同名命令的行为需 P1 用真机复测。
- `-14` 过期后 `start()` 因“已有网关”不再重建，必须 `/wx login`；符合当前设计。
