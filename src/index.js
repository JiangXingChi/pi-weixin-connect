/**
 * pi-weixin-connect：微信 ClawBot（iLink）⇄ 当前 Pi 会话。
 *
 * 微信消息 → pi.sendUserMessage() → Pi 干完活 → 最终 assistant 文本回微信。
 * 所有消息进同一个 Pi 会话，上下文连续。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath, credentialsPath, loadConfig } from "./config.js";
import { Logger } from "./log.js";
import { WeixinApi } from "./api.js";
import {
	backupCredentials,
	clearCredentials,
	dropCredentialsBackup,
	loadCredentials,
	login as qrLogin,
	restoreCredentials,
} from "./auth.js";
import { WeixinGateway } from "./gateway.js";
import { WeixinBridge, isStaleContextError } from "./session.js";
import { acquireLock, isProcessAlive, readLock, releaseLock } from "./lock.js";
import {
	describeService,
	isServiceAlive,
	isServiceProcess,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	startManagedService,
	startService,
	stopService,
} from "./service.js";
import { maskId } from "./text.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_BIN = path.resolve(HERE, "..", "bin", "pi-weixin-connect.mjs");
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(path.resolve(HERE, "..", "package.json"), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function baseDir() {
	return path.dirname(configPath());
}

function lockFilePath() {
	return path.join(baseDir(), "pi-weixin-connect.lock");
}

const STATE_LABEL = {
	idle: "未启动",
	connecting: "连接中",
	connected: "在线",
	disconnected: "重连中",
	expired: "会话过期",
	error: "出错",
	stopped: "已停止",
	disabled: "已关闭",
	unconfigured: "未登录",
	locked: "被占用",
};

const RUNTIME_KEY = Symbol.for("pi-weixin-connect.runtime.v1");
const root = globalThis;

function newRuntime() {
	return {
		ctx: undefined,
		pi: undefined,
		config: undefined,
		logger: undefined,
		api: undefined,
		gateway: undefined,
		bridge: undefined,
		credentials: undefined,
		error: null,
		starting: false,
		owner: undefined,
		ownerStale: false,
		lockWatch: undefined,
		lastInbound: undefined,
		loginInFlight: false,
	};
}

const shared = root[RUNTIME_KEY] ?? (root[RUNTIME_KEY] = newRuntime());

export function resetRuntimeForTests() {
	shared.bridge?.stop?.();
	shared.gateway?.stop?.();
	if (shared.lockWatch) clearInterval(shared.lockWatch);
	Object.assign(shared, newRuntime());
	delete shared.seenInstances;
}

export default function createExtension(pi) {
	const state = shared;
	state.pi = pi;

	const seen = (state.seenInstances ??= new WeakSet());
	if (seen.has(pi)) return state;
	seen.add(pi);

	function setStatus(label, detail) {
		const text = detail ? `微信: ${label} · ${detail}` : `微信: ${label}`;
		try {
			state.ctx?.ui?.setStatus?.("weixin", text);
		} catch {
			// 非 TUI 模式可能没有状态栏
		}
	}

	function notify(message, level = "info") {
		state.logger?.[level === "warning" ? "warn" : level === "error" ? "error" : "info"](message);
		try {
			state.ctx?.ui?.notify?.(message, level);
		} catch {
			// 没有 UI 时只落日志
		}
	}

	function stop({ release = true } = {}) {
		if (state.lockWatch) {
			clearInterval(state.lockWatch);
			state.lockWatch = undefined;
		}
		try {
			state.gateway?.stop();
		} catch {
			// ignore
		}
		state.bridge?.stop();
		state.gateway = undefined;
		state.bridge = undefined;
		if (release && state.config?.lock !== false) releaseLock(lockFilePath());
	}

	async function start(ctx) {
		if (state.starting) return;
		state.starting = true;
		state.ctx = ctx ?? state.ctx;
		try {
			// 扩展可能被同一个 Pi 进程加载两次：已有活动网关时只接棒，不再起第二条长轮询
			if (state.gateway && state.gateway.state !== "stopped") {
				state.bridge?.adopt(state.pi ?? pi);
				state.ctx = ctx ?? state.ctx;
				return;
			}
			stop({ release: false });
			state.error = null;

			const { config, warnings, error } = loadConfig();
			state.config = config;
			state.logger = new Logger(config.log);
			for (const warning of warnings) state.logger.info(warning);
			if (error) {
				state.error = error;
				setStatus(STATE_LABEL.error, error);
				notify(`pi-weixin-connect: ${error}`, "warning");
				return;
			}
			if (!config.enabled) {
				setStatus(STATE_LABEL.disabled);
				state.logger.info("配置 enabled=false，未连接");
				return;
			}

			const credentials = loadCredentials();
			state.credentials = credentials;
			if (!credentials) {
				setStatus(STATE_LABEL.unconfigured);
				notify("pi-weixin-connect: 还没有登录。在终端运行 /wx login 扫码。", "info");
				return;
			}

			// 默认 standalone：微信只跑在独立后台进程里。
			// 当前进程若是服务本身（或显式 inline）才在这里连长轮询。
			const svc = readServiceState(serviceStatePath(baseDir()));
			const svcAlive = Boolean(svc && isServiceAlive(svc));
			const selfService = isServiceProcess(svc);
			if (!selfService && config.service.mode !== "inline") {
				if (svcAlive) {
					stop({ release: true });
					setStatus("服务在线", `pid ${svc.pid}`);
					notify(`微信后台服务在线（pid ${svc.pid}），本进程不连长轮询；用 /wx status 查看`, "info");
					return;
				}
				if (svc) removeServiceState(serviceStatePath(baseDir()), svc.pid);
				stop({ release: true });
				const started = await startManagedService({
					binPath: SERVICE_BIN,
					baseDir: baseDir(),
					cwd: state.ctx?.cwd ?? os.homedir(),
					sessionId: config.service.sessionId,
				});
				if (!started.pid) {
					state.error = started.error ?? "无法启动后台服务";
					setStatus(STATE_LABEL.error, state.error);
					notify(`微信后台服务启动失败：${state.error}\n日志：${started.logFile}`, "warning");
					return;
				}
				setStatus("服务启动中", `pid ${started.pid}`);
				notify(`已自动启动微信后台服务（pid ${started.pid}）；日志：${started.logFile}`, "info");
				return;
			}

			const api = new WeixinApi({
				baseUrl: config.endpoints.base,
				cdnBaseUrl: config.endpoints.cdn,
				version: VERSION,
				log: state.logger,
			});
			state.api = api;

			if (config.lock) {
				let lock = acquireLock(lockFilePath());
				for (let attempt = 0; !lock.ok && attempt < 4; attempt++) {
					await sleep(1000);
					lock = acquireLock(lockFilePath());
				}
				if (!lock.ok) {
					state.error = `长轮询已被另一个 Pi 进程持有（pid ${lock.holder?.pid}）`;
					setStatus(STATE_LABEL.locked, `pid ${lock.holder?.pid}`);
					notify(`pi-weixin-connect: ${state.error}。关掉那个进程后再试。`, "warning");
					return;
				}
				if (lock.takenOver) notify("pi-weixin-connect: 已接管长轮询锁", "info");
				state.lockWatch = setInterval(() => {
					const holder = readLock(lockFilePath());
					if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
						notify(`微信长轮询已被 pid ${holder.pid} 接管，本进程断开`, "warning");
						stop({ release: false });
						setStatus(STATE_LABEL.locked, `pid ${holder.pid}`);
					}
				}, 30_000);
				state.lockWatch.unref?.();
			}

			const bridge = new WeixinBridge({
				pi: state.pi ?? pi,
				api,
				config,
				log: state.logger,
				notify,
				credentials,
				onExpired: () => {
					setStatus(STATE_LABEL.expired);
					notify("微信登录已过期（-14）：运行 /wx login 重新扫码。", "warning");
				},
			});
			const gateway = new WeixinGateway({
				api,
				token: credentials.token,
				userId: credentials.userId,
				log: state.logger,
				onMessage: (item) => {
					state.lastInbound = { at: new Date().toISOString(), user: maskId(item.from), len: item.text.length };
					const result = bridge.enqueue(item);
					if (!result.accepted) state.logger.debug(`消息未入队：${result.reason}`);
				},
				onState: (s) => {
					setStatus(STATE_LABEL[s] ?? s);
					if (s === "connected") state.error = null;
				},
				onExpired: () => {
					setStatus(STATE_LABEL.expired);
					notify("微信登录已过期（-14）：运行 /wx login 重新扫码。", "warning");
				},
			});

			state.bridge = bridge;
			state.gateway = gateway;
			setStatus(STATE_LABEL.connecting);
			state.logger.info(`启动 iLink 长轮询：bot=${maskId(credentials.botId)} user=${maskId(credentials.userId)}`);
			void gateway.start().catch((err) => {
				state.error = err?.message ?? String(err);
				state.logger.error(`网关启动失败：${state.error}`);
				setStatus(STATE_LABEL.error, state.error);
			});
		} catch (err) {
			state.error = err?.message ?? String(err);
			state.logger?.error(`启动失败：${err?.stack ?? err}`);
			setStatus(STATE_LABEL.error, state.error);
			notify(`pi-weixin-connect 启动失败：${state.error}`, "warning");
		} finally {
			state.starting = false;
		}
	}

	function statusReport() {
		const cfg = state.config;
		const lines = [];
		lines.push(`配置：${configPath()}${cfg ? "" : "（未加载）"}`);
		lines.push(`凭证：${credentialsPath()}${state.credentials ? "（已登录）" : "（未登录）"}`);
		if (state.error) lines.push(`错误：${state.error}`);
		if (!cfg) return lines.join("\n");
		const cred = state.credentials;
		if (cred) lines.push(`Bot：${maskId(cred.botId)} · 用户 ${maskId(cred.userId)}`);
		const gw = state.gateway;
		lines.push(`长轮询：${gw ? STATE_LABEL[gw.state] ?? gw.state : "未启动"}`);
		lines.push(`权限：用户白名单 ${cfg.allowUsers.length} 个${cfg.allowUsers.length === 0 ? "（仅登录者本人）" : ""}`);
		const lock = readLock(lockFilePath());
		lines.push(`锁：${lock ? `pid ${lock.pid}（${lock.at}）` : "无"}`);
		lines.push(`后台服务：${describeService(readServiceState(serviceStatePath(baseDir())))}（模式 ${cfg.service.mode}）`);
		if (state.bridge) {
			const s = state.bridge.status;
			const flags = [s.busy ? "Pi 忙" : "", s.switching ? "切换中" : "", s.stale ? "已暂停" : ""].filter(Boolean).join(" · ");
			lines.push(
				`队列：${s.queue} 条 · 已收 ${s.stats.received} / 已发 ${s.stats.sent} / 失败 ${s.stats.failed} / 忽略 ${s.stats.ignored}${flags ? ` · ${flags}` : ""}`,
			);
		}
		if (state.lastInbound) lines.push(`最近入站：${state.lastInbound.at} · 用户 ${state.lastInbound.user} · ${state.lastInbound.len} 字`);
		lines.push(`预算：每条消息最多 ${cfg.maxChunks} 段 × ${cfg.chunkChars} 字 · 窗口 ${cfg.sessionWindowHours}h`);
		try {
			const model = state.ctx?.model ?? state.pi?.model;
			if (model) lines.push(`模型：${model.provider ?? "?"}/${model.id ?? model.modelId ?? "?"}`);
			const sessionId = state.ctx?.sessionManager?.getSessionId?.();
			if (sessionId) lines.push(`Pi 会话：${sessionId}`);
		} catch {
			// ignore
		}
		return lines.join("\n");
	}

	/** 扫码登录：二维码落盘 + 提示路径；配对码优先用 TUI 输入。 */
	async function doLogin(ctx, { force = false } = {}) {
		if (state.loginInFlight) {
			notify("上一次扫码还没结束，稍等", "warning");
			return;
		}
		state.loginInFlight = true;
		let backup = null;
		let loggedIn = false;
		try {
			const { config } = loadConfig();
			const logger = state.logger ?? new Logger(config.log);
			state.logger = logger;
			const api = new WeixinApi({
				baseUrl: config.endpoints.base,
				cdnBaseUrl: config.endpoints.cdn,
				version: VERSION,
				log: logger,
			});
			backup = force ? backupCredentials() : null;
			notify("正在获取微信登录二维码…", "info");
			let qrShown = false;
			const credentials = await qrLogin({
				api,
				log: logger,
				onQr: (qr) => {
					qrShown = true;
					const where = qr.pngPath ? `二维码已保存：${qr.pngPath}` : `二维码内容：${qr.content}`;
					notify(`${where}\n用微信扫码并确认。`, "info");
					if (qr.ansi) logger.info(`二维码（终端）：\n${qr.ansi}`);
				},
				onStatus: (text) => logger.info(text),
				onNeedVerifyCode: async () => {
					if (typeof ctx?.ui?.input === "function") {
						try {
							// RPC 通道里客户端可能不回应 input：最多等 120 秒，别把整个登录挂死
							let timer;
							const timeout = new Promise((resolve) => {
								timer = setTimeout(() => resolve(null), 120_000);
								timer.unref?.();
							});
							try {
								return await Promise.race([ctx.ui.input("请输入手机微信上显示的配对码"), timeout]);
							} finally {
								clearTimeout(timer);
							}
						} catch {
							return null;
						}
					}
					return null;
				},
			});
			loggedIn = true;
			notify(`微信登录成功：用户 ${maskId(credentials.userId)}`, "info");
			state.credentials = credentials;
			const svc = readServiceState(serviceStatePath(baseDir()));
			if (config.service.mode !== "inline") {
				// 默认 standalone：登录完成后由独立服务接管；有旧服务就先停掉
				if (svc && isServiceAlive(svc)) {
					await stopService(svc, { force: true });
					removeServiceState(serviceStatePath(baseDir()), svc.pid);
				}
				stop({ release: true });
				const started = await startManagedService({
					binPath: SERVICE_BIN,
					baseDir: baseDir(),
					cwd: state.ctx?.cwd ?? os.homedir(),
					sessionId: config.service.sessionId,
				});
				notify(
					started.pid
						? `凭证已更新，微信独立服务已启动（pid ${started.pid}）`
						: `凭证已更新，但服务启动失败：${started.error ?? "未知原因"}`,
					started.pid ? "info" : "warning",
				);
			} else {
				stop({ release: true });
				await start(ctx);
			}
			dropCredentialsBackup(backup);
			if (qrShown && !state.gateway) notify("登录成功，但网关没有启动，查看 /wx status 或日志", "warning");
		} catch (err) {
			// 只有扫码本身失败才回滚旧凭证；登录已成功、只是网关没起来时保留新凭证
			if (!loggedIn) restoreCredentials(backup);
			else dropCredentialsBackup(backup);
			loggerSafeError(err);
			notify(`扫码登录失败：${err?.message ?? err}`, "warning");
		} finally {
			state.loginInFlight = false;
		}
	}

	function loggerSafeError(err) {
		try {
			state.logger?.error(`登录失败：${err?.stack ?? err}`);
		} catch {
			// ignore
		}
	}

	/** 拉起独立后台服务。 */
	async function startBackground() {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc && isServiceAlive(svc)) {
			notify(`后台服务已在运行：${describeService(svc)}`, "info");
			return;
		}
		if (svc && !isProcessAlive(svc.pid)) removeServiceState(file, svc.pid);
		if (!state.credentials) {
			notify("还没有登录，先 /wx login 扫码", "warning");
			return;
		}
		const cwd = state.ctx?.cwd ?? os.homedir();
		const started = await startManagedService({
			binPath: SERVICE_BIN,
			baseDir: baseDir(),
			cwd,
			sessionId: state.config?.service?.sessionId ?? "pi-weixin-connect-service",
		});
		if (!started.pid) {
			notify(`后台服务启动失败：${started.error ?? "没有拿到 pid"}\n日志：${started.logFile}`, "warning");
			return;
		}
		let current = readServiceState(file);
		for (let i = 0; i < 40 && !(current && isServiceAlive(current)); i++) {
			await sleep(200);
			current = readServiceState(file);
		}
		if (current && isServiceAlive(current)) {
			// 服务接管长轮询：本进程让出
			stop({ release: true });
			setStatus("服务在线", `pid ${current.pid}`);
			notify(`微信后台服务已启动：${describeService(current)}\n日志：${started.logFile}`, "info");
		} else {
			notify(`后台服务启动中（pid ${started.pid}），稍后 /wx status 查看。日志：${started.logFile}`, "warning");
		}
	}

	/** 停止独立后台服务；没有服务时断开本进程。 */
	async function stopBackground(force = false) {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc && isProcessAlive(svc.pid)) {
			const result = await stopService(svc, { force });
			if (!result.stopped) {
				notify(`停止失败：${result.reason}`, "warning");
				return;
			}
			removeServiceState(file, svc.pid);
			setStatus(STATE_LABEL.stopped);
			notify("微信后台服务已停止", "info");
			return;
		}
		if (svc) removeServiceState(file, svc.pid);
		stop({ release: true });
		notify("已断开本进程的微信连接", "info");
		setStatus(STATE_LABEL.stopped);
	}

	const HELP = [
		"用法：/wx <命令>",
		"  status        查看登录、长轮询、队列、预算",
		"  login [--force]  扫码登录（首次或 -14 过期后）",
		"  start         启动独立后台服务（微信走单独进程）",
		"  stop [--force] 停止后台服务；没有服务时断开本进程",
		"  logout        删除本机凭证并断开",
		"  log [n]       看最近 n 条日志（默认 20）",
		"",
		"微信里可直接用终端命令：/new /model /thinking /compact /session /name /tools /help（P1 接入）。",
	].join("\n");

	let commandsRegistered = false;
	function registerCommands() {
		if (commandsRegistered) return;
		commandsRegistered = true;
		pi.registerCommand("wx", {
			description: "微信 ClawBot：status / login / logout / log",
			handler: async (args, ctx) => {
				state.ctx = ctx;
				const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
				switch (sub || "status") {
					case "status":
						notify(statusReport(), "info");
						return;
					case "login":
						await doLogin(ctx, { force: rest.includes("--force") });
						return;
					case "start":
						await startBackground();
						return;
					case "stop":
						await stopBackground(rest.includes("--force"));
						return;
					case "logout": {
						const svc = readServiceState(serviceStatePath(baseDir()));
						if (svc && isServiceAlive(svc)) {
							await stopService(svc, { force: true });
							removeServiceState(serviceStatePath(baseDir()), svc.pid);
						}
						stop({ release: true });
						clearCredentials();
						state.credentials = undefined;
						notify("已删除微信凭证并断开连接", "info");
						setStatus(STATE_LABEL.unconfigured);
						return;
					}
					case "log": {
						const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
						notify(state.logger?.tail(n)?.join("\n") ?? "（没有日志）", "info");
						return;
					}
					default:
						notify(HELP, "info");
				}
			},
		});
	}

	pi.on("session_start", (event, ctx) => {
		if (state.ownerStale || state.ctx !== ctx) {
			state.ownerStale = false;
			state.owner = pi;
		} else if (state.owner && state.owner !== pi) {
			return;
		}
		state.owner = pi;
		state.ctx = ctx;
		state.pi = pi;
		const reason = event?.reason ?? "startup";
		registerCommands();

		if (!state.bridge && !state.gateway) {
			if (reason !== "startup") notify(`会话已切换（${reason}），没有活动桥，正在重建微信连接…`, "warning");
			void start(ctx);
			return;
		}
		state.bridge?.adopt(pi);
		if (state.bridge?.switching) state.bridge.endSwitch();
		else void state.bridge?.pump();
	});

	pi.on("session_shutdown", (event) => {
		const reason = event?.reason ?? "unknown";
		if (state.owner && state.owner !== pi) return;
		state.logger?.info(`session_shutdown(${reason})`);
		if (reason === "quit" || reason === "exit" || reason === "shutdown") {
			state.owner = undefined;
			state.ownerStale = false;
			stop();
			return;
		}
		state.ownerStale = true;
		state.bridge?.beginSwitch();
	});

	pi.on("before_agent_start", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onBeforeAgentStart(event);
	});

	pi.on("agent_start", () => {
		if (state.owner !== pi) return;
		state.bridge?.onAgentStart();
	});

	pi.on("message_end", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onMessageEnd(event.message);
	});

	pi.on("agent_settled", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onAgentSettled(Boolean(event.aborted));
	});

	return state;
}

export { isStaleContextError, lockFilePath, maskId };
