/**
 * iLink Bot HTTP 封装。
 *
 * 只负责协议：请求头、base_info、超时、错误归一化（ret / errcode）。
 * 业务状态（游标、context_token、typing ticket）由 gateway / session 管。
 */

import crypto from "node:crypto";

export const SESSION_EXPIRED_ERRCODE = -14;

export class ApiError extends Error {
	constructor(message, { status = 0, ret, errcode, body } = {}) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.ret = ret;
		this.errcode = errcode;
		this.body = body;
	}
}

export function isSessionExpired(err) {
	return err?.errcode === SESSION_EXPIRED_ERRCODE || err?.ret === SESSION_EXPIRED_ERRCODE;
}

function randomUin() {
	const uint32 = crypto.randomBytes(4).readUInt32BE(0);
	return Buffer.from(String(uint32), "utf8").toString("base64");
}

function clientVersion(version) {
	const parts = String(version ?? "0.0.0")
		.split(".")
		.map((p) => parseInt(p, 10) || 0);
	return ((parts[0] & 0xff) << 16) | ((parts[1] & 0xff) << 8) | (parts[2] & 0xff);
}

export class WeixinApi {
	constructor({ baseUrl, cdnBaseUrl, version = "0.1.0", log, botAgent } = {}) {
		this.baseUrl = String(baseUrl ?? "https://ilinkai.weixin.qq.com").replace(/\/+$/, "");
		this.cdnBaseUrl = String(cdnBaseUrl ?? "https://novac2c.cdn.weixin.qq.com/c2c").replace(/\/+$/, "");
		this.version = version;
		this.log = log;
		this.botAgent = botAgent || `pi-weixin-connect/${version}`;
	}

	baseInfo() {
		return { channel_version: this.version, bot_agent: this.botAgent };
	}

	#headers(token) {
		const headers = {
			"Content-Type": "application/json",
			AuthorizationType: "ilink_bot_token",
			"X-WECHAT-UIN": randomUin(),
			"iLink-App-Id": "bot",
			"iLink-App-ClientVersion": String(clientVersion(this.version)),
		};
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	async #request(baseUrl, path, { method = "GET", body, token, timeoutMs = 20_000, signal } = {}) {
		const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
		// 外部 signal 只负责“取消”，超时必须自己兜住；两者取并集
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		try {
			const res = await fetch(url, {
				method,
				headers: this.#headers(token),
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: combined,
			});
			const text = await res.text();
			let data = null;
			if (text) {
				try {
					data = JSON.parse(text);
				} catch {
					// 200 + 非 JSON（反代门户页、HTML 错误页）必须当失败，
					// 否则 getupdates 会把它当空结果，200ms 一次热轮询
					if (res.ok) {
						throw new ApiError(`响应不是 JSON：${method} ${url.pathname}`, {
							status: res.status,
							body: text.slice(0, 200),
						});
					}
				}
			}
			if (!res.ok) {
				throw new ApiError(`HTTP ${res.status} ${method} ${url.pathname}`, {
					status: res.status,
					body: text.slice(0, 500),
				});
			}
			const ret = Number(data?.ret);
			const errcode = Number(data?.errcode);
			if (Number.isFinite(ret) && ret !== 0) {
				throw new ApiError(`iLink ret=${ret}${data?.errmsg ? ` ${data.errmsg}` : ""}`, {
					status: res.status,
					ret,
					errcode: Number.isFinite(errcode) ? errcode : undefined,
					body: text.slice(0, 500),
				});
			}
			if (Number.isFinite(errcode) && errcode !== 0) {
				throw new ApiError(`iLink errcode=${errcode}${data?.errmsg ? ` ${data.errmsg}` : ""}`, {
					status: res.status,
					ret: Number.isFinite(ret) ? ret : undefined,
					errcode,
					body: text.slice(0, 500),
				});
			}
			return data ?? {};
		} catch (err) {
			if (err?.name === "AbortError") {
				throw new ApiError(signal?.aborted ? `请求已取消：${path}` : `请求超时：${path}`, { status: 0 });
			}
			throw err;
		} finally {
			clearTimeout(timer);
		}
	}

	// ── 登录 ──────────────────────────────────────────────────────────

	async getQrCode(localTokenList = [], baseUrl = this.baseUrl) {
		return this.#request(baseUrl, "/ilink/bot/get_bot_qrcode?bot_type=3", {
			method: "POST",
			body: { local_token_list: localTokenList.slice(0, 10) },
		});
	}

	async getQrStatus(qrcode, verifyCode, baseUrl = this.baseUrl) {
		let path = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
		if (verifyCode) path += `&verify_code=${encodeURIComponent(verifyCode)}`;
		return this.#request(baseUrl, path, { method: "GET", timeoutMs: 35_000 });
	}

	// ── 消息 ──────────────────────────────────────────────────────────

	async getUpdates(token, cursor, { signal, timeoutMs = 45_000 } = {}) {
		const data = await this.#request(this.baseUrl, "/ilink/bot/getupdates", {
			method: "POST",
			token,
			body: { get_updates_buf: String(cursor ?? ""), base_info: this.baseInfo() },
			signal,
			timeoutMs,
		});
		// 空对象意味着响应体是空的（#request 对空体返回 {}）。长轮询不能把这种
		// 响应当成功，否则会 200ms 一次热循环。
		if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
			throw new ApiError("getupdates 返回空响应", { status: 200 });
		}
		return data;
	}

	async sendText(token, { to, contextToken, text, clientId, runId }) {
		return this.sendItems(token, {
			to,
			contextToken,
			itemList: [{ type: 1, text_item: { text } }],
			clientId,
			runId,
		});
	}

	async sendItems(token, { to, contextToken, itemList, clientId, runId }) {
		const msg = {
			from_user_id: "",
			to_user_id: to,
			client_id: clientId || crypto.randomUUID(),
			message_type: 2,
			message_state: 2,
			context_token: contextToken,
			item_list: itemList,
		};
		if (runId) msg.run_id = runId;
		return this.#request(this.baseUrl, "/ilink/bot/sendmessage", {
			method: "POST",
			token,
			body: { msg, base_info: this.baseInfo() },
			timeoutMs: 30_000,
		});
	}

	async getUploadUrl(token, params) {
		return this.#request(this.baseUrl, "/ilink/bot/getuploadurl", {
			method: "POST",
			token,
			body: { ...params, base_info: this.baseInfo() },
			timeoutMs: 30_000,
		});
	}

	// ── 输入状态 / 在线状态 ──────────────────────────────────────────

	async getConfig(token, { userId, contextToken } = {}) {
		const body = { ilink_user_id: userId, base_info: this.baseInfo() };
		if (contextToken) body.context_token = contextToken;
		return this.#request(this.baseUrl, "/ilink/bot/getconfig", { method: "POST", token, body });
	}

	async sendTyping(token, { userId, ticket, status = 1 }) {
		return this.#request(this.baseUrl, "/ilink/bot/sendtyping", {
			method: "POST",
			token,
			body: {
				ilink_user_id: userId,
				typing_ticket: ticket,
				status,
				base_info: this.baseInfo(),
			},
		});
	}

	async notifyOnline(token, up) {
		return this.#request(this.baseUrl, up ? "/ilink/bot/msg/notifystart" : "/ilink/bot/msg/notifystop", {
			method: "POST",
			token,
			body: { base_info: this.baseInfo() },
			timeoutMs: 15_000,
		});
	}
}
