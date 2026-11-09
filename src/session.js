/**
 * 微信 ⇄ Pi 会话桥：串行队列、去重、注入、收集最终回答、回复。
 *
 * 关键约束（微信 iLink）：
 *  - 回复必须带该用户入站消息里的 context_token；
 *  - 24 小时内没有新的用户消息，token 失效，发不出去；
 *  - Bot 连续发送 10 条后，用户不回复会被阻断（默认预算 9 条）；
 *  - 微信不渲染 Markdown，默认纯文本。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isSessionExpired } from "./api.js";
import { randomInt } from "node:crypto";

import { downloadMedia, parseFileMarkers, sniffImageMime, uploadFile } from "./media.js";
import { buildPrompt, chunkText, isAllowed, maskId, stripMarkdown } from "./text.js";

export function isStaleContextError(err) {
	return /stale after session replacement or reload/i.test(String(err?.message ?? err ?? ""));
}

export function retryDelayFor(count) {
	return Math.min(2000 * 2 ** Math.max(0, count - 1), 30_000);
}

function messageText(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
	}
	return "";
}

export class WeixinBridge {
	constructor({ pi, api, config, log, notify, credentials, onExpired, injectTimeoutMs = 5000 }) {
		this.pi = pi;
		this.api = api;
		this.cfg = config;
		this.log = log;
		this.notify = notify ?? (() => {});
		this.credentials = credentials;
		this.onExpired = onExpired ?? (() => {});

		this.queue = [];
		this.deferred = [];
		this.inflight = undefined;
		this.running = false;
		this.finishing = false;
		this.pumping = false;
		this.injecting = false;
		this.stale = false;
		this.switching = false;
		this.retryCount = 0;
		this.injectTimeoutMs = injectTimeoutMs;
		this.stopped = false;

		this.seen = new Map();
		this.contextTokens = new Map();
		this.lastInboundAt = new Map();
		this.typingTickets = new Map();
		this.stats = { received: 0, ignored: 0, sent: 0, failed: 0 };
	}

	get status() {
		return {
			queue: this.queue.length,
			deferred: this.deferred.length,
			switching: this.switching,
			busy: this.running,
			stale: this.stale,
			inflight: this.inflight ? { user: maskId(this.inflight.item.from), chunks: this.inflight.texts.length } : null,
			stats: { ...this.stats },
		};
	}

	stop() {
		this.stopped = true;
		this.#clearTimers();
		this.#stopTyping(this.inflight);
		this.queue = [];
		this.deferred = [];
		this.inflight = undefined;
		this.running = false;
	}

	adopt(pi) {
		if (pi) this.pi = pi;
		if (!this.stale) return;
		this.stale = false;
		this.retryCount = 0;
		this.injecting = false;
		this.log?.info(`新会话实例已接管微信桥，积压 ${this.queue.length} 条`);
		void this.pump();
	}

	beginSwitch() {
		this.switching = true;
		if (this.switchTimer) clearTimeout(this.switchTimer);
		// 兜底：Pi 没有给出 session_start（切换失败/被打断）时不能永久停摆
		this.switchTimer = setTimeout(() => {
			this.switchTimer = undefined;
			if (!this.switching) return;
			this.log?.warn("会话切换 30 秒未完成，恢复队列");
			this.endSwitch();
		}, 30_000);
		this.switchTimer.unref?.();
	}

	endSwitch() {
		this.switching = false;
		if (this.switchTimer) {
			clearTimeout(this.switchTimer);
			this.switchTimer = undefined;
		}
		if (this.deferred.length > 0) {
			const rest = this.deferred;
			this.deferred = [];
			for (const item of rest) this.queue.push(item);
		}
		void this.pump();
	}

	cancelSwitch() {
		this.switching = false;
		if (this.switchTimer) {
			clearTimeout(this.switchTimer);
			this.switchTimer = undefined;
		}
	}

	/** 入队；返回 {accepted, reason}。 */
	enqueue(item) {
		if (this.stopped) return { accepted: false, reason: "stopped" };
		if (this.#duplicate(item)) {
			this.stats.ignored++;
			return { accepted: false, reason: "duplicate" };
		}
		if (!isAllowed(item, this.cfg, this.credentials?.userId)) {
			this.stats.ignored++;
			this.log?.warn(`忽略非白名单用户：${maskId(item.from)}`);
			return { accepted: false, reason: "not-allowed" };
		}
		if (item.contextToken) this.contextTokens.set(item.from, item.contextToken);
		this.lastInboundAt.set(item.from, item.at || Date.now());

		if (this.switching) {
			if (this.deferred.length >= this.cfg.maxQueue) {
				this.log?.warn(`切换期间暂存已满（${this.cfg.maxQueue}），丢弃一条消息`);
				return { accepted: false, reason: "queue-full" };
			}
			this.deferred.push(item);
			return { accepted: true, deferred: true };
		}
		if (this.queue.length >= this.cfg.maxQueue) {
			this.log?.warn(`队列已满（${this.cfg.maxQueue}），丢弃一条来自 ${maskId(item.from)} 的消息`);
			return { accepted: false, reason: "queue-full" };
		}
		this.queue.push(item);
		this.stats.received++;
		void this.pump();
		return { accepted: true };
	}

	#duplicate(item) {
		const key = item.messageId || `${item.at}|${item.from}|${item.text.slice(0, 80)}`;
		const now = Date.now();
		for (const [k, at] of this.seen) {
			if (now - at > this.cfg.dedupeTtlMs) this.seen.delete(k);
		}
		if (this.seen.has(key)) return true;
		this.seen.set(key, now);
		return false;
	}

	onBeforeAgentStart(event) {
		const inflight = this.inflight;
		if (!inflight) return;
		if (event?.messageType && event.messageType !== "user") {
			inflight.foreign = true;
			return;
		}
		const prompt = String(event?.prompt ?? "").trim();
		if (!prompt) return;
		if (prompt !== inflight.promptText.trim()) {
			inflight.foreign = true;
			this.log?.warn("这一轮不是微信消息触发的，跳过收集");
			return;
		}
		inflight.started = true;
		if (this.injectTimer) {
			clearTimeout(this.injectTimer);
			this.injectTimer = undefined;
		}
	}

	onAgentStart() {
		this.running = true;
	}

	onMessageEnd(message) {
		if (!this.inflight || this.inflight.foreign || !this.inflight.started) return;
		if (message?.role !== "assistant") return;
		const text = messageText(message).trim();
		if (!text) return;
		this.inflight.texts.push(text);
	}

	onAgentSettled(aborted = false) {
		this.running = false;
		const inflight = this.inflight;
		if (!inflight) {
			void this.pump();
			return;
		}
		if (!inflight.started) {
			// 这一轮不是由我们的注入触发的（或 Pi 静默拒绝了这条注入）：
			// 必须清掉 inflight，否则 pump 的守卫会让整个队列永久卡住。
			this.log?.warn("本轮没有正常开始，消息放回队列重试");
			if (this.injectTimer) {
				clearTimeout(this.injectTimer);
				this.injectTimer = undefined;
			}
			this.inflight = undefined;
			this.#stopTyping(inflight);
			inflight.item.attempts = (inflight.item.attempts ?? 0) + 1;
			if (inflight.item.attempts >= 3) {
				this.stats.failed++;
				this.log?.error(`同一条消息连续 3 次没能让 Pi 开始，丢弃：${maskId(inflight.item.from)}`);
			} else {
				this.queue.unshift(inflight.item);
				this.injecting = true;
				this.#scheduleRetry();
			}
			return;
		}
		if (this.injectTimer) {
			clearTimeout(this.injectTimer);
			this.injectTimer = undefined;
		}
		if (aborted && inflight.texts.length === 0) {
			this.log?.warn("本轮被中止且没有输出，跳过回复");
			this.inflight = undefined;
			this.#stopTyping(inflight);
			void this.pump();
			return;
		}
		void this.#finish(inflight);
	}

	async #finish(inflight) {
		this.inflight = undefined;
		this.finishing = true;
		this.#stopTyping(inflight);
		try {
			if (inflight.foreign && inflight.texts.length === 0) {
				this.log?.warn("这一轮不是微信请求触发的，未回复");
				return;
			}
			const text = inflight.texts.join("\n\n").trim() || this.cfg.emptyReply;
			await this.#deliver(inflight, text);
		} catch (err) {
			this.stats.failed++;
			this.log?.error(`回复失败：${err?.stack ?? err}`);
			this.notify(`微信回复失败：${err?.message ?? err}`, "warning");
			if (isSessionExpired(err)) this.onExpired(err);
		} finally {
			this.finishing = false;
			void this.pump();
		}
	}

	async pump() {
		if (
			this.stopped ||
			this.stale ||
			this.switching ||
			this.pumping ||
			this.finishing ||
			this.injecting ||
			this.inflight ||
			this.running ||
			this.queue.length === 0
		)
			return;
		this.pumping = true;
		try {
			await this.#pumpOnce();
		} catch (err) {
			this.log?.error(`注入流程异常：${err?.stack ?? err}`);
			this.#scheduleRetry();
		} finally {
			this.pumping = false;
			if (!this.stopped && !this.finishing && !this.injecting && !this.inflight && !this.running && this.queue.length > 0) {
				void this.pump();
			}
		}
	}

	async #pumpOnce() {
		const item = this.queue.shift();
		let images = [];
		let files = [];
		let prompt;
		try {
			const notes = [];
			images = await this.#collectImages(item, notes);
			files = await this.#collectFiles(item, notes);
			// 下载期间可能 stop / 开始换会话：别把消息注入到已结束或正在切换的会话
			if (this.stopped) return;
			if (this.switching) {
				if (this.deferred.length >= this.cfg.maxQueue) {
					this.log?.warn(`切换期间暂存已满（${this.cfg.maxQueue}），丢弃一条消息`);
					return;
				}
				this.deferred.push(item);
				return;
			}
			prompt = buildPrompt(item, this.cfg, notes);
		} catch (err) {
			// 处理入站附件时出错不能让消息凭空消失
			this.log?.error(`准备入站消息失败：${err?.stack ?? err}`);
			if (!this.stopped && !this.switching) this.queue.unshift(item);
			this.#scheduleRetry();
			return;
		}
		const inflight = {
			item,
			promptText: prompt.text,
			texts: [],
			started: false,
			foreign: false,
			attemptsLeft: this.cfg.maxChunks,
			startedAt: Date.now(),
		};
		this.inflight = inflight;

		try {
			const content = images.length > 0 ? [{ type: "text", text: prompt.text }, ...images] : prompt.text;
			this.pi.sendUserMessage(content);
			this.retryCount = 0;
			this.log?.info(`已注入 Pi（用户 ${maskId(item.from)}，图片 ${images.length} 张，文件 ${files.length} 个）`);
			this.#armInjectWatchdog(inflight);
			this.#startTyping(inflight);
		} catch (err) {
			this.inflight = undefined;
			if (isStaleContextError(err)) {
				this.#failOnStale(item, err);
				return;
			}
			this.queue.unshift(item);
			this.injecting = true;
			this.log?.warn(`注入失败，等空闲后重试：${err?.message ?? err}`);
			this.#scheduleRetry();
		}
	}

	/** 下载入站图片 → Pi 图片内容。失败只记说明，不阻塞文本。 */
	async #collectImages(item, notes) {
		const cfg = this.cfg.images ?? {};
		if (!cfg.enabled || !item.images?.length) return [];
		const list = item.images.slice(0, Math.max(0, cfg.maxCount ?? 2));
		if (item.images.length > list.length) notes.push(`（另有 ${item.images.length - list.length} 张图片未下载）`);
		const results = await Promise.all(
			list.map(async (image) => {
				try {
					const buf = await downloadMedia({
						media: image.media,
						itemAeskey: image.aeskey,
						cdnBaseUrl: this.cfg.endpoints.cdn,
						maxBytes: cfg.maxBytes ?? 8 * 1024 * 1024,
					});
					if (!buf?.length) throw new Error("空文件");
					return { type: "image", data: buf.toString("base64"), mimeType: sniffImageMime(buf) };
				} catch (err) {
					this.log?.warn(`入站图片下载失败：${err?.message ?? err}`);
					notes.push("[图片下载失败]");
					return null;
				}
			}),
		);
		return results.filter(Boolean);
	}

	/** 下载入站文件到插件目录，并把路径告诉模型。 */
	async #collectFiles(item, notes) {
		const cfg = this.cfg.files ?? {};
		if (!cfg.enabled || !item.files?.length) return [];
		const list = item.files.slice(0, Math.max(0, cfg.maxCount ?? 3));
		const saved = [];
		for (const file of list) {
			try {
				const buf = await downloadMedia({
					media: file.media,
					cdnBaseUrl: this.cfg.endpoints.cdn,
					maxBytes: cfg.maxBytes ?? 200 * 1024 * 1024,
					requireKey: true,
				});
				// 放 /tmp：既能再发回去（~/.pi/agent 是出站敏感目录），也符合临时产物约定
				const dir = process.env.PIWXCONNECT_FILES_DIR || path.join(os.tmpdir(), "pi-weixin-connect", "files");
				fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
				const safe = String(file.name || "file.bin").replace(/[^\w.\-]/g, "_").slice(0, 80);
				const target = path.join(dir, `${Date.now()}-${randomInt(1000, 9999)}-${safe}`);
				fs.writeFileSync(target, buf, { mode: 0o600 });
				saved.push(target);
				notes.push(`[文件] ${file.name} → ${target}`);
			} catch (err) {
				this.log?.warn(`入站文件下载失败：${err?.message ?? err}`);
				notes.push(`[文件下载失败] ${file.name}`);
			}
		}
		return saved;
	}

	#failOnStale(item, err) {
		const reason = err?.message ?? String(err);
		const first = !this.stale;
		this.stale = true;
		this.injecting = false;
		this.#stopTyping(this.inflight);
		if (item) this.queue.unshift(item);
		if (first) {
			this.log?.error(`会话已被替换，暂停注入直到新会话接棒：${reason}`);
			this.notify("微信桥已暂停：Pi 会话被替换，等新会话接手后自动恢复", "warning");
		}
	}

	#scheduleRetry() {
		if (this.retryTimer || this.stopped) return;
		this.retryCount = (this.retryCount ?? 0) + 1;
		const delay = retryDelayFor(this.retryCount);
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			this.injecting = false;
			void this.pump();
		}, delay);
		this.retryTimer.unref?.();
	}

	#armInjectWatchdog(inflight) {
		if (!this.injectTimeoutMs || this.injectTimeoutMs <= 0) return;
		if (this.injectTimer) clearTimeout(this.injectTimer);
		this.injectTimer = setTimeout(() => {
			this.injectTimer = undefined;
			if (this.inflight !== inflight || inflight.started || this.stopped) return;
			this.log?.warn("Pi 5 秒内没有开始这一轮，放回队列重试");
			this.inflight = undefined;
			this.#stopTyping(inflight);
			inflight.item.attempts = (inflight.item.attempts ?? 0) + 1;
			if (inflight.item.attempts >= 3) {
				this.stats.failed++;
				this.log?.error(`同一条消息连续 3 次未能注入，丢弃：${maskId(inflight.item.from)}`);
			} else {
				this.queue.unshift(inflight.item);
				this.injecting = true;
				this.#scheduleRetry();
			}
		}, this.injectTimeoutMs);
		this.injectTimer.unref?.();
	}

	#clearTimers() {
		for (const key of ["injectTimer", "retryTimer", "switchTimer"]) {
			if (this[key]) clearTimeout(this[key]);
			this[key] = undefined;
		}
	}

	async #deliver(inflight, text) {
		if (this.stopped) return;
		const { item } = inflight;
		const target = item.from;
		const contextToken = this.contextTokens.get(target) || item.contextToken;
		if (!contextToken) {
			this.log?.warn(`没有 context_token，无法回复 ${maskId(target)}`);
			return;
		}

		// 24 小时窗口：token 以最后一条用户消息为起点
		const windowMs = this.cfg.sessionWindowHours * 3600_000;
		const last = this.lastInboundAt.get(target) || item.at || Date.now();
		if (Date.now() - last > windowMs) {
			this.log?.warn("已超过 24 小时窗口，回复未发送");
			this.notify("微信 24 小时窗口已过：请在微信里先发一条消息，再重试", "warning");
			return;
		}

		const parsed = parseFileMarkers(text, {
			maxCount: this.cfg.files?.enabled ? this.cfg.files.maxCount : 0,
			maxBytes: this.cfg.files?.enabled ? this.cfg.files.maxBytes : 0,
			allowDirs: this.cfg.files?.allowDirs,
			// 关闭文件发送时也要把标记从正文里剥掉，否则绝对路径会直接发到微信
			disabled: !this.cfg.files?.enabled,
		});
		for (const skip of parsed.skipped) {
			this.log?.warn(skip.path ? `文件标记被忽略：${skip.path}（${skip.reason}）` : `文件标记被忽略：${skip.reason}`);
		}

		let body = this.cfg.replyFormat === "markdown" ? parsed.text.trim() : stripMarkdown(parsed.text);
		if (parsed.skipped.length > 0) {
			const skippedCount = parsed.skipped.reduce((n, skip) => n + (Number(skip.count) || 1), 0);
			const detail = parsed.skipped
				.slice(0, 3)
				.map((skip) => {
					const name = path.basename(String(skip.path || ""));
					return name ? `${name}：${skip.reason}` : skip.reason;
				})
				.join("；");
			body = [body, `（${skippedCount} 个文件未发送：${detail}）`].filter(Boolean).join("\n");
		}
		const textBudget = Math.max(1, inflight.attemptsLeft - parsed.files.length);
		const chunks = chunkText(body, {
			chunkChars: this.cfg.chunkChars,
			maxChunks: Math.min(textBudget, this.cfg.maxChunks),
			overflowHint: "……（内容过长，已截断）",
		});

		for (const chunk of chunks) {
			if (this.stopped) return;
			await this.#sendWithRetry("文本", () =>
				this.api.sendText(this.credentials.token, { to: target, contextToken, text: chunk }),
			);
			this.stats.sent++;
			inflight.attemptsLeft--;
			this.log?.info(`已发送文本 ${maskId(target)}：${chunk.length} 字`);
		}

		for (const file of parsed.files) {
			if (this.stopped) return;
			if (inflight.attemptsLeft <= 0) {
				this.log?.warn(`回复预算用完，文件未发送：${file.path}`);
				break;
			}
			try {
				const uploaded = await uploadFile(this.api, this.credentials.token, {
					to: target,
					filePath: file.path,
					mediaType: file.mediaType,
					cdnBaseUrl: this.cfg.endpoints.cdn,
					log: this.log,
				});
				await this.#sendWithRetry("媒体", () =>
					this.api.sendItems(this.credentials.token, {
						to: target,
						contextToken,
						itemList: [buildMediaItem(file.kind, uploaded)],
					}),
				);
				this.stats.sent++;
				inflight.attemptsLeft--;
				this.log?.info(`已发送${file.kind === "image" ? "图片" : "文件"} ${file.name}（${uploaded.rawSize} 字节）`);
			} catch (err) {
				this.stats.failed++;
				this.log?.error(`文件发送失败 ${file.path}：${err?.stack ?? err}`);
				if (inflight.attemptsLeft > 0) {
					await this.#sendWithRetry("失败提示", () =>
						this.api.sendText(this.credentials.token, {
							to: target,
							contextToken,
							text: `（文件发送失败：${file.name} — ${err?.message ?? err}）`,
						}),
					);
					this.stats.sent++;
					inflight.attemptsLeft--;
				}
			}
		}
	}

	/** 文本/媒体发送重试：网络错误与 5xx 重试，4xx 与业务错误码立即失败。 */
	async #sendWithRetry(label, fn, attempts = 3) {
		let lastError;
		for (let i = 0; i < attempts; i++) {
			try {
				if (this.stopped) throw new Error("桥已停止");
				return await fn();
			} catch (err) {
				lastError = err;
				if (this.stopped) throw err;
				const status = Number(err?.status ?? 0);
				const business = err?.errcode !== undefined || err?.ret !== undefined;
				const retryableStatus = [408, 425, 429].includes(status);
				const fatal = (status >= 400 && status < 500 && !retryableStatus) || business;
				if (fatal) throw err;
				this.log?.warn(`${label}发送失败 ${i + 1}/${attempts}：${err?.message ?? err}`);
				if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
			}
		}
		throw lastError ?? new Error(`${label}发送失败`);
	}

	// ── 输入状态 ──────────────────────────────────────────────────────

	async #startTyping(inflight) {
		if (!this.cfg.typing) return;
		inflight.typing = true;
		const user = inflight.item.from;
		try {
			let ticket = this.typingTickets.get(user);
			if (!ticket) {
				const config = await this.api.getConfig(this.credentials.token, {
					userId: user,
					contextToken: this.contextTokens.get(user),
				});
				ticket = config?.typing_ticket;
				if (ticket) this.typingTickets.set(user, ticket);
			}
			if (!ticket || !inflight.typing) return;
			await this.api.sendTyping(this.credentials.token, { userId: user, ticket, status: 1 });
			// stop 可能发生在 await 期间：补一次“取消输入”，保证微信端不残留输入态
			if (!inflight.typing) {
				await this.api
					.sendTyping(this.credentials.token, { userId: user, ticket, status: 2 })
					.catch(() => {});
			}
		} catch (err) {
			inflight.typing = false;
			this.log?.debug(`typing 开始失败：${err?.message ?? err}`);
		}
	}

	#stopTyping(inflight) {
		if (!inflight?.typing) return;
		const user = inflight.item.from;
		const ticket = this.typingTickets.get(user);
		inflight.typing = false;
		if (!ticket) return;
		void this.api
			.sendTyping(this.credentials.token, { userId: user, ticket, status: 2 })
			.catch((err) => this.log?.debug(`typing 结束失败：${err?.message ?? err}`));
	}
}

function buildMediaItem(kind, uploaded) {
	if (kind === "image") {
		return {
			type: 2,
			image_item: {
				media: uploaded.media,
				mid_size: uploaded.cipherSize,
			},
		};
	}
	if (kind === "video") {
		return {
			type: 5,
			video_item: {
				media: uploaded.media,
				video_size: uploaded.cipherSize,
			},
		};
	}
	return {
		type: 4,
		file_item: {
			media: uploaded.media,
			file_name: uploaded.name,
			len: String(uploaded.rawSize),
		},
	};
}
