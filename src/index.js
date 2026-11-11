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
	stopService,
} from "./service.js";
import { maskId } from "./text.js";
import { CODE, err } from "./i18n.js";

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

function liveService() {
	const state = readServiceState(serviceStatePath(baseDir()));
	return state && isServiceAlive(state) ? state : null;
}

function lockFilePath() {
	return path.join(baseDir(), "pi-weixin-connect.lock");
}

const STATE_LABEL = {
	idle: "not started",
	connecting: "connecting",
	connected: "online",
	disconnected: "reconnecting",
	expired: "session expired",
	error: "error",
	stopped: "stopped",
	disabled: "disabled",
	unconfigured: "not logged in",
	locked: "locked",
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
		pendingExec: undefined,
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
		const text = detail ? `wx: ${label} · ${detail}` : `wx: ${label}`;
		try {
			state.ctx?.ui?.setStatus?.("weixin", text);
		} catch {
			// 非 TUI 模式可能没有状态栏
		}
	}

	function notify(message, level = "info", { silent = false } = {}) {
		state.logger?.[level === "warning" ? "warn" : level === "error" ? "error" : "info"](message);
		// startup / background status notices stay in the log only
		if (silent) return;
		try {
			state.ctx?.ui?.notify?.(message, level);
		} catch {
			// 没有 UI 时只落日志
		}
	}

	/** 开新会话：失败只提示，不打断当前会话；返回值给聊天侧回执用。 */
	async function switchSession(ctx, name = "") {
		const label = String(name ?? "").trim();
		try {
			const result = await ctx.newSession({
				setup: async (sessionManager) => {
					if (label) sessionManager.appendSessionInfo(label);
				},
				withSession: (next) => {
					state.ctx = next;
				},
			});
			if (result?.cancelled) return { ok: false, cancelled: true, message: "cancelled" };
			return { ok: true };
		} catch (err) {
			if (isStaleContextError(err)) {
				return { ok: false, message: "this session was replaced by another switch" };
			}
			return { ok: false, message: err?.message ?? String(err) };
		}
	}

	/** 聊天侧开新会话：借 /wx __new 这条扩展命令走 ctx.newSession（ctx 只在命令里有）。 */
	function requestNewSession(args = "") {
		if (state.pendingExec) {
			return Promise.resolve({ ok: false, message: "a new-session request is already in progress" });
		}
		return new Promise((resolve) => {
			let settled = false;
			const done = (result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				const owner = state.pendingExec?.done === done;
				const pending = state.pendingExec;
				if (owner) state.pendingExec = undefined;
				// 切换失败且没真的开始换会话：立刻解除暂停，别让队列停摆 30 秒
				if (!result?.ok && owner && !pending?.sawShutdown) state.bridge?.cancelSwitch();
				resolve(result);
			};
			const timer = setTimeout(() => done({ ok: false, message: "pi did not switch sessions within 35s" }), 35_000);
			timer.unref?.();
			state.pendingExec = { done };
			state.bridge?.beginSwitch();
			try {
				state.pi.sendUserMessage(args ? `/wx __new ${args}` : "/wx __new", { expandPromptTemplates: true });
			} catch (err) {
				done({ ok: false, message: err?.message ?? String(err) });
			}
		});
	}

	const BUILTIN_COMMANDS = new Set([
		"settings",
		"model",
		"tree",
		"thinking",
		"scoped-models",
		"export",
		"import",
		"share",
		"bug",
		"copy",
		"name",
		"session",
		"changelog",
		"hotkeys",
		"fork",
		"clone",
		"trust",
		"login",
		"logout",
		"new",
		"compact",
		"resume",
		"reload",
		"quit",
		"help",
		"tools",
	]);

	function isKnownCommand(name) {
		if (BUILTIN_COMMANDS.has(name)) return true;
		try {
			return (state.pi?.getCommands?.() ?? []).some((item) => String(item.name).toLowerCase() === name);
		} catch {
			return false;
		}
	}

	/** 聊天窗口里的斜杠命令：只映射 /new，其余一律提示回终端。 */
	async function handleChatCommand(command) {
		switch (command.name) {
			case "new": {
				const result = await requestNewSession(command.args);
				if (result?.cancelled) return err(CODE.NEW_SESSION_FAILED, "new session cancelled");
				if (!result?.ok) {
					return err(CODE.NEW_SESSION_FAILED, "could not open a new session", result?.message ?? "unknown reason");
				}
				return command.args ? `new session started (${command.args})` : "new session started";
			}
			default:
				// 只有真正存在的命令才拒绝；`/tmp`、`/var 为什么…` 这类当普通消息
				if (!isKnownCommand(command.name)) return null;
				return err(CODE.TUI_ONLY, `/${command.raw ?? command.name} runs in the terminal; only /new works here`);
		}
	}


	function stop({ release = true } = {}) {
		if (state.pendingExec) {
			state.pendingExec.done({ ok: false, message: "background service stopped" });
			state.pendingExec = undefined;
		}
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
				notify(err(CODE.CONFIG, "config error", error), "warning");
				// 之前可能是 inline 轮询进程：不再连长轮询时必须把锁还回去
				stop({ release: true });
				return;
			}
			if (!config.enabled) {
				setStatus(STATE_LABEL.disabled);
				state.logger.info("配置 enabled=false，未连接");
				stop({ release: true });
				return;
			}

			const credentials = loadCredentials();
			state.credentials = credentials;
			if (!credentials) {
				setStatus(STATE_LABEL.unconfigured);
				notify(err(CODE.NOT_LOGGED_IN, "not logged in; run /wx login in the terminal"), "warning");
				stop({ release: true });
				return;
			}

			// 默认 standalone：微信只跑在独立后台进程里。
			// 当前进程若是服务本身（或显式 inline）才在这里连长轮询。
			const svc = readServiceState(serviceStatePath(baseDir()));
			const svcAlive = Boolean(svc && isServiceAlive(svc));
			const svcProcessAlive = Boolean(svc && isProcessAlive(svc.pid));
			const selfService = isServiceProcess();
			if (!selfService && config.service.mode !== "inline") {
				if (svcAlive) {
					stop({ release: true });
					setStatus("service online", `pid ${svc.pid}`);
					notify(`background service online (pid ${svc.pid}); this process does not poll; see /wx status`, "info", { silent: true });
					return;
				}
				if (svcProcessAlive) {
					// 进程还在但心跳停了：再拉一个只会抢锁/双开，交给用户明确处理
					state.error = `background service pid ${svc.pid} is alive but its heartbeat stopped`;
					setStatus(STATE_LABEL.error, state.error);
					notify(err(CODE.SERVICE_STALE, "background service heartbeat stopped", `pid ${svc.pid}; run /wx stop --force then retry`), "warning");
					stop({ release: true });
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
					state.error = started.error ?? "could not start background service";
					setStatus(STATE_LABEL.error, state.error);
					notify(err(CODE.SERVICE_START_FAILED, "could not start background service", `${state.error} (log: ${started.logFile})`), "warning");
					return;
				}
				setStatus("service starting", `pid ${started.pid}`);
				notify(`background service started automatically (pid ${started.pid}); log: ${started.logFile}`, "info", { silent: true });
				return;
			}

			const api = new WeixinApi({
				// 登录返回的 baseurl 是后续 Bot 请求的正式入口；IDC 重定向后不能继续打默认域名
				baseUrl: process.env.PIWXCONNECT_BASE ? config.endpoints.base : credentials.baseUrl || config.endpoints.base,
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
					state.error = `long-polling lock held by another Pi process (pid ${lock.holder?.pid})`;
					setStatus(STATE_LABEL.locked, `pid ${lock.holder?.pid}`);
					notify(err(CODE.LOCK_HELD, "long-polling lock held by another Pi process", `pid ${lock.holder?.pid}; close it and retry`), "warning");
					return;
				}
				if (lock.takenOver) notify("took over the long-polling lock", "info", { silent: true });
				state.lockWatch = setInterval(() => {
					const holder = readLock(lockFilePath());
					if (holder && holder.pid !== process.pid && isProcessAlive(holder.pid)) {
						notify(err(CODE.LOCK_TAKEN, "long-polling taken over by another process", `pid ${holder.pid}; disconnecting`), "warning");
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
				onCommand: (command) => handleChatCommand(command),
				credentials,
				onExpired: () => {
					setStatus(STATE_LABEL.expired);
					notify(err(CODE.LOGIN_EXPIRED, "weixin login expired (-14); run /wx login to scan again"), "warning");
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
					notify(err(CODE.LOGIN_EXPIRED, "weixin login expired (-14); run /wx login to scan again"), "warning");
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
		} catch (cause) {
			state.error = cause?.message ?? String(cause);
			state.logger?.error(`启动失败：${cause?.stack ?? cause}`);
			setStatus(STATE_LABEL.error, state.error);
			notify(err(CODE.START_FAILED, "pi-weixin-connect failed to start", state.error), "warning");
			// 启动到一半抛异常时不要留着锁
			stop({ release: true });
		} finally {
			state.starting = false;
		}
	}

	function statusReport() {
		const cfg = state.config;
		const cred = loadCredentials() ?? state.credentials;
		const lines = [];
		lines.push(`config: ${configPath()}${cfg ? "" : " (not loaded)"}`);
		lines.push(`credentials: ${credentialsPath()}${cred ? " (logged in)" : " (not logged in)"}`);
		if (state.error) lines.push(`error: ${state.error}`);
		if (!cfg) return lines.join("\n");
		if (cred) lines.push(`bot: ${maskId(cred.botId)} · user ${maskId(cred.userId)}`);
		const gw = state.gateway;
		const svcForPoll = liveService();
		lines.push(
			`long polling: ${gw ? STATE_LABEL[gw.state] ?? gw.state : svcForPoll ? `served by background service (pid ${svcForPoll.pid})` : "not running"}`,
		);
		lines.push(`acl: users ${cfg.allowUsers.length}${cfg.allowUsers.length === 0 ? " (only the logged-in user)" : ""}`);
		const lock = readLock(lockFilePath());
		lines.push(`lock: ${lock ? `pid ${lock.pid} (${lock.at})` : "none"}`);
		lines.push(`service: ${describeService(readServiceState(serviceStatePath(baseDir())))} (mode ${cfg.service.mode})`);
		if (state.bridge) {
			const s = state.bridge.status;
			const flags = [s.busy ? "pi busy" : "", s.switching ? "switching" : "", s.stale ? "paused" : ""].filter(Boolean).join(" · ");
			lines.push(
				`queue: ${s.queue} · received ${s.stats.received} / sent ${s.stats.sent} / failed ${s.stats.failed} / ignored ${s.stats.ignored}${flags ? ` · ${flags}` : ""}`,
			);
		}
		if (state.lastInbound) lines.push(`last inbound: ${state.lastInbound.at} · user ${state.lastInbound.user} · ${state.lastInbound.len} chars`);
		lines.push(`budget: up to ${cfg.maxChunks} chunks × ${cfg.chunkChars} chars per message · window ${cfg.sessionWindowHours}h`);
		try {
			const sessionId = state.ctx?.sessionManager?.getSessionId?.();
			if (sessionId) lines.push(`pi session: ${sessionId}`);
			const model = state.ctx?.model ?? state.pi?.model;
			if (model) lines.push(`model: ${model.provider ?? "?"}/${model.id ?? model.modelId ?? "?"}`);
			lines.push(`thinking: ${state.pi?.getThinkingLevel?.() ?? "unknown"}`);
			const usage = state.ctx?.getContextUsage?.();
			if (usage) {
				const tokens = usage.tokens ?? usage.usedTokens;
				const window = usage.contextWindow ?? usage.maxTokens;
				const percent = Number.isFinite(usage.percent) ? ` (${Math.round(usage.percent)}%)` : "";
				lines.push(`context: ${tokens ?? "?"} / ${window ?? "?"}${percent}`);
			}
			const tools = state.pi?.getActiveTools?.() ?? [];
			if (tools.length) lines.push(`tools: ${tools.length}`);
		} catch {
			// ignore
		}
		return lines.join("\n");
	}

	/** 扫码登录：二维码落盘 + 提示路径；配对码优先用 TUI 输入。 */
	async function doLogin(ctx, { force = false } = {}) {
		if (state.loginInFlight) {
			notify(err(CODE.QR_BUSY, "previous QR login is still running; wait a moment"), "warning");
			return;
		}
		state.loginInFlight = true;
		let backup = null;
		let loggedIn = false;
		try {
			const { config } = loadConfig();
			state.config = config;
			const logger = state.logger ?? new Logger(config.log);
			state.logger = logger;
			const api = new WeixinApi({
				baseUrl: config.endpoints.base,
				cdnBaseUrl: config.endpoints.cdn,
				version: VERSION,
				log: logger,
			});
			backup = force ? backupCredentials() : null;
			notify("fetching weixin login QR code...", "info");
			let qrShown = false;
			const credentials = await qrLogin({
				api,
				log: logger,
				onQr: (qr) => {
					qrShown = true;
					const where = qr.pngPath ? `QR saved: ${qr.pngPath}` : `QR content: ${qr.content}`;
					notify(`${where}\nscan it with WeChat and confirm.`, "info");
					if (qr.ansi) logger.debug(`已生成终端二维码（${qr.ansi.split("\n").length} 行），不写入日志`);
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
								return await Promise.race([ctx.ui.input("Enter the pairing code shown on WeChat"), timeout]);
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
			state.error = null;
			notify(`weixin login ok: user ${maskId(credentials.userId)}`, "info");
			state.credentials = credentials;
			const svc = readServiceState(serviceStatePath(baseDir()));
			if (config.service.mode !== "inline") {
				// 默认 standalone：登录完成后由独立服务接管；有旧服务就先停掉
				// （心跳过期但进程还活着也要停，否则旧进程会拿着旧 token 继续轮询）
				let oldServiceStopped = true;
				if (svc && isProcessAlive(svc.pid)) {
					const stopped = await stopService(svc, { force: true });
					if (stopped.stopped) {
						removeServiceState(serviceStatePath(baseDir()), svc.pid);
					} else {
						oldServiceStopped = false;
						notify(err(CODE.STOP_OLD_FAILED, "previous background service did not stop; login will not restart it", stopped.reason), "warning");
					}
				}
				// 无论旧服务是否停掉，控制面自己都不能再拿旧凭证轮询
				stop({ release: true });
				if (oldServiceStopped) {
					const started = await startManagedService({
						binPath: SERVICE_BIN,
						baseDir: baseDir(),
						cwd: state.ctx?.cwd ?? os.homedir(),
						sessionId: config.service.sessionId,
					});
					notify(
						started.pid
							? `credentials updated; background service started (pid ${started.pid})`
							: err(CODE.SERVICE_START_FAILED, "credentials updated but service did not start", started.error ?? "unknown reason"),
						started.pid ? "info" : "warning",
					);
				}
			} else {
				stop({ release: true });
				await start(ctx);
			}
			dropCredentialsBackup(backup);
			if (!credentials.userId) {
				notify(err(CODE.LOGIN_NO_USERID, "login ok but the server returned no user id; the default allowlist rejects all messages, retry /wx login"), "warning");
			}
			if (config.service.mode === "inline" && qrShown && !state.gateway)
				notify(err(CODE.GATEWAY_NOT_STARTED, "login ok but the gateway did not start; see /wx status or the log"), "warning");
		} catch (cause) {
			// 只有扫码本身失败才回滚旧凭证；登录已成功、只是网关没起来时保留新凭证
			if (!loggedIn) restoreCredentials(backup);
			else dropCredentialsBackup(backup);
			loggerSafeError(cause);
			notify(err(CODE.LOGIN_FAILED, "QR login failed", cause?.message ?? cause), "warning");
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
			notify(`background service already running: ${describeService(svc)}`, "info");
			return;
		}
		if (svc && isProcessAlive(svc.pid)) {
			// 进程活着、心跳过期：不要双开，让用户先显式停掉
			notify(err(CODE.SERVICE_STALE, "background service heartbeat stopped", `pid ${svc.pid}; run /wx stop --force then start again`), "warning");
			return;
		}
		if (svc) removeServiceState(file, svc.pid);
		// 控制面可能在启动后才用 scripts/login.mjs 扫码，这里重新读一次，别用启动时缓存的空值
		const credentials = loadCredentials();
		if (credentials) state.credentials = credentials;
		if (!state.credentials) {
			notify(err(CODE.NOT_LOGGED_IN, "not logged in; run /wx login first"), "warning");
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
			notify(err(CODE.SERVICE_START_FAILED, "could not start background service", `${started.error ?? "no pid"} (log: ${started.logFile})`), "warning");
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
			setStatus("service online", `pid ${current.pid}`);
			notify(`weixin background service started: ${describeService(current)}\nlog: ${started.logFile}`, "info");
		} else {
			notify(`background service starting (pid ${started.pid}); check /wx status later; log: ${started.logFile}`, "info");
		}
	}

	/** 停止独立后台服务；没有服务时断开本进程。 */
	async function stopBackground(force = false) {
		const file = serviceStatePath(baseDir());
		const svc = readServiceState(file);
		if (svc && isProcessAlive(svc.pid)) {
			const result = await stopService(svc, { force });
			if (!result.stopped) {
				notify(err(CODE.STOP_FAILED, "stop failed", result.reason), "warning");
				return;
			}
			removeServiceState(file, svc.pid);
			setStatus(STATE_LABEL.stopped);
			notify("weixin background service stopped", "info");
			return;
		}
		if (svc) removeServiceState(file, svc.pid);
		stop({ release: true });
		notify("disconnected this process from weixin", "info");
		setStatus(STATE_LABEL.stopped);
	}

	const HELP = [
		"usage: /wx <command>",
		"  status          service, connection, queue, budget",
		"  start           start the background service",
		"  stop [--force]  stop the service; disconnects this process when none runs",
		"  log [n]         show the last n log lines (default 20)",
		"  help            this list",
		"  login [--force] QR login (first time or after -14)",
		"  logout          delete local credentials and disconnect",
		"",
		"In chat: only /new works; every other command runs in the terminal.",
	].join("\n");

	let commandsRegistered = false;
	function registerCommands() {
		if (commandsRegistered) return;
		commandsRegistered = true;
		pi.registerCommand("wx", {
			description: "WeChat ClawBot: status / login / logout / log",
			handler: async (args, ctx) => {
				state.ctx = ctx;
				const [sub, ...rest] = String(args ?? "").trim().split(/\s+/);
				switch (sub || "status") {
					case "status":
						notify(statusReport(), "info");
						return;
					case "__new": {
						const pending = state.pendingExec;
						if (!pending) {
							notify(err(CODE.NEW_SESSION_FAILED, "no pending new-session request"), "warning");
							return;
						}
						const result = await switchSession(ctx, rest.join(" "));
						pending.done(result);
						return;
					}
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
						// 心跳过期但进程还活着也要停，否则旧进程会拿着已删除的 token 继续轮询
						if (svc && isProcessAlive(svc.pid)) {
							const stopped = await stopService(svc, { force: true });
							if (!stopped.stopped) {
								notify(err(CODE.LOGOUT_BLOCKED, "cannot stop background service; logout cancelled, run /wx stop --force first", stopped.reason), "warning");
								return;
							}
						}
						// 服务已退出、但状态文件还在时也要清掉，否则 /wx status 一直显示“进程已退出”
						if (svc) removeServiceState(serviceStatePath(baseDir()), svc.pid);
						stop({ release: true });
						clearCredentials();
						state.credentials = undefined;
						notify("weixin credentials deleted; connection closed", "info");
						setStatus(STATE_LABEL.unconfigured);
						return;
					}
					case "log": {
						const n = Number(rest[0]) > 0 ? Math.min(Number(rest[0]), 200) : 20;
						notify(state.logger?.tail(n)?.join("\n") ?? "(no log)", "info");
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
			const svc = liveService();
			if (svc && (state.config?.service?.mode ?? "standalone") !== "inline") {
				// 独立服务在跑：控制面每次 /new 都不该再拉起一遍，也不该报“正在重建”；
				// 但仍然要跑 start() 把配置/凭证读进来，后台服务状态才算完整。
				setStatus("service online", `pid ${svc.pid}`);
				void start(ctx);
				return;
			}
			if (reason !== "startup")
				notify(`session switched (${reason}); rebuilding weixin connection...`, "info", { silent: true });
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
		if (state.pendingExec) state.pendingExec.sawShutdown = true;
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
		state.bridge?.onMessageEnd(event?.message);
	});

	pi.on("agent_settled", (event) => {
		if (state.owner !== pi) return;
		state.bridge?.onAgentSettled(Boolean(event?.aborted));
	});

	return state;
}

export { isStaleContextError, lockFilePath, maskId };
