# 第 3 轮审改（2026-11-02）

范围：第 2 轮修复后的全部源码、测试、PLAN/AGENTS。只读复读 → 记录 → 统一修。

## 第 2 轮修复核对

8 项全部落地；30 项测试通过。抽查了 `#sendWithRetry`、`#startTyping`、`auth.login` 的 `try/finally`，行为符合预期。

## 本轮新发现

1. **typing 收尾仍有窗口。** `#startTyping` 通过检查后 `await sendTyping(1)`，此时 stop 可能已发过 `status:2`；await 返回后不会再补取消，微信端仍可能停在“正在输入”。
   → await 后若 `inflight.typing === false`，补发一次 `status:2`。
2. **会话切换没有看门狗。** `beginSwitch()` 之后若 Pi 没有给 `session_start`（切换失败/被打断），`switching` 永久为 true，队列停摆。
   → 30 秒超时自动 `endSwitch()`；`stop()` 清理该定时器。
3. **发送循环不看 `stopped`。** 关闭/退出时可能继续把剩余分片和文件发完。
   → 每个分片/文件发送前检查 `stopped`；重试器在 stopped 时立即抛出。
4. **二维码状态轮询没有失败上限。** 状态接口持续报错时（网络断/服务端异常）会一直轮询到二维码过期，最长两分钟无明确失败。
   → 连续 5 次失败即报错退出。
5. **取二维码用了 redirect 后的地址。** IDC 重定向只适用于状态轮询；二维码请求应固定打官方基座，否则过期重取可能 404。
   → `getQrCode` 固定 `api.baseUrl`，`getQrStatus` 才用 redirect。
6. **入站文件名直接进 prompt。** 文件名含换行/制表符时可以伪造 prompt 行。
   → 归一化时压平空白并截断 120 字。
7. **入站文件缺少 AES key 时被当明文保存。** 官方对文件/语音会跳过；我们存的是密文垃圾。
   → `downloadMedia({ requireKey:true })`，缺 key 直接失败并记占位。
8. **文档与实现不一致。** PLAN §5 仍列 `commands.js`（实际内联）、AGENTS 仍写“二维码放项目 tmp/”。
   → 已同步：PLAN 文件表、AGENTS 路径与测试数、PLAN §10 决策与 §11 执行记录。

修复后 `node --test` 30/30 通过，`/wx status` 的 RPC 冒烟检查通过。
