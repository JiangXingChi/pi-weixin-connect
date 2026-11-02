/**
 * 长轮询网关：getupdates → 归一化 → 交给桥。
 *
 * 约束（来自腾讯官方协议文档与官方实现）：
 *  - 服务端挂起约 35s，长轮询超时按返回的 longpolling_timeout_ms；
 *  - get_updates_buf 是不透明游标，只能前进；
 *  - ret/errcode = -14 表示会话过期，官方客户端暂停 1 小时后重试；这里交给上层提示重登。
 */

import { isSessionExpired } from "./api.js";
import { normalizeMessage } from "./text.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WeixinGateway {
	constructor({ api, token, userId, log, onMessage, onState, onExpired }) {
		this.api = api;
		this.token = token;
		this.userId = userId;
		this.log = log;
		this.onMessage = onMessage;
		this.onState = onState ?? (() => {});
		this.onExpired = onExpired ?? (() => {});

		this.cursor = "";
		this.state = "idle";
		this.stopped = false;
		this.controller = null;
		this.failures = 0;
		this.lastError = null;
		this.stats = { received: 0, ignored: 0 };
	}

	#setState(state) {
		this.state = state;
		this.onState(state);
	}

	async start() {
		if (this.stopped) return;
		this.#setState("connecting");
		try {
			await this.api.notifyOnline(this.token, true);
		} catch (err) {
			this.log?.warn(`notifyStart 失败：${err?.message ?? err}`);
		}
		void this.#loop();
	}

	stop() {
		this.stopped = true;
		this.controller?.abort();
		this.controller = null;
		this.#setState("stopped");
		try {
			void this.api.notifyOnline(this.token, false).catch(() => {});
		} catch {
			// ignore
		}
	}

	async #loop() {
		let failures = 0;
		let nextTimeoutMs = 45_000;
		while (!this.stopped) {
			try {
				this.controller = new AbortController();
				const res = await this.api.getUpdates(this.token, this.cursor, {
					signal: this.controller.signal,
					timeoutMs: nextTimeoutMs + 5_000,
				});
				this.failures = 0;
				this.#setState("connected");
				const hint = Number(res?.longpolling_timeout_ms);
				if (Number.isFinite(hint) && hint > 0) nextTimeoutMs = Math.min(Math.max(hint, 1_000), 60_000);
				if (typeof res?.get_updates_buf === "string" && res.get_updates_buf) this.cursor = res.get_updates_buf;

				const msgs = Array.isArray(res?.msgs) ? res.msgs : [];
				for (const raw of msgs) {
					const item = normalizeMessage(raw);
					if (!item) {
						this.stats.ignored++;
						continue;
					}
					this.stats.received++;
					try {
						this.onMessage?.(item);
					} catch (err) {
						this.log?.error(`处理消息失败：${err?.stack ?? err}`);
					}
				}

				if (msgs.length === 0) {
					// 服务端已经挂起过（约 35s），这里只做很短的让出，别再把延迟翻倍
					await sleep(200);
				}
			} catch (err) {
				if (this.stopped) break;
				if (isSessionExpired(err)) {
					this.lastError = err;
					this.log?.error("会话过期（-14），需要重新扫码登录");
					this.#setState("expired");
					this.onExpired(err);
					return;
				}
				failures++;
				this.lastError = err;
				this.log?.warn(`getupdates 失败 ${failures}/3：${err?.message ?? err}`);
				this.#setState(failures >= 3 ? "disconnected" : "connecting");
				await sleep(failures >= 3 ? 30_000 : Math.min(2000 * failures, 10_000));
				if (failures >= 3) failures = 0;
			}
		}
	}
}
