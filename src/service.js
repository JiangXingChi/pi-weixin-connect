/**
 * 后台常驻服务管理：独立 `pi --mode rpc` 进程承载微信会话。
 *
 * - `bin/pi-weixin-connect.mjs` 启动后写状态文件，每 15 秒心跳
 * - 插件读状态文件判断服务是否在线；在线时本进程只当控制面，不抢长轮询
 * - `/wx start|stop` 通过 detached spawn / SIGTERM 管理它
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_STALE_MS = 45_000;

export function serviceStatePath(baseDir) {
	return path.join(baseDir, "pi-weixin-connect.service.json");
}

export function serviceLogPath(baseDir) {
	return path.join(baseDir, "pi-weixin-connect.service.log");
}

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

export function readServiceState(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || !Number.isInteger(data.pid)) return null;
		return data;
	} catch {
		return null;
	}
}

export function writeServiceState(file, data) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function removeServiceState(file, pid = process.pid) {
	const state = readServiceState(file);
	if (state && state.pid !== pid) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// ignore
	}
}

/** 在线 = 进程活着 + 心跳没超时。 */
export function isServiceAlive(state, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
	if (!state || !isProcessAlive(state.pid)) return false;
	const at = Date.parse(state.heartbeatAt ?? state.startedAt ?? "");
	if (!Number.isFinite(at)) return false;
	return now - at <= staleMs;
}

export function describeService(state, { now = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
	if (!state) return "not running";
	const alive = isProcessAlive(state.pid);
	const fresh = isServiceAlive(state, { now, staleMs });
	const parsed = Date.parse(state.heartbeatAt ?? "");
	const beat = Number.isFinite(parsed) ? Math.round((now - parsed) / 1000) : null;
	const detail = !alive ? "process exited" : fresh ? "online" : beat === null ? "heartbeat time unknown" : `heartbeat stopped ${beat}s ago`;
	return `pid ${state.pid} · ${detail} · session ${state.sessionId ?? "?"}`;
}

/** 拉起后台服务（detached，父进程退出后仍在）。 */
export function startService({ binPath, baseDir, cwd, sessionId = "pi-weixin-connect-service", nodePath = process.execPath }) {
	const logFile = serviceLogPath(baseDir);
	if (!fs.existsSync(binPath)) return { pid: null, logFile, error: `start script not found: ${binPath}` };
	if (!fs.existsSync(cwd)) return { pid: null, logFile, error: `working directory does not exist: ${cwd}` };
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	try {
		if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
	} catch {
		// ignore
	}
	let out;
	try {
		out = fs.openSync(logFile, "a", 0o600);
		const env = { ...process.env };
		// 不要把自己的 launcher 标记带进子进程，否则嵌套启动时 ppid 判断会错
		delete env.PIWXCONNECT_SERVICE_PID;
		const child = spawn(nodePath, [binPath, "--cwd", cwd, "--session-id", sessionId], {
			cwd,
			detached: true,
			stdio: ["ignore", out, out],
			env,
		});
		child.on("error", (err) => {
			try {
				fs.appendFileSync(logFile, `[pi-weixin-connect] spawn 失败：${err?.message ?? err}\n`);
			} catch {
				// ignore
			}
		});
		child.unref();
		return { pid: child.pid ?? null, logFile };
	} catch (err) {
		return { pid: null, logFile, error: err?.message ?? String(err) };
	} finally {
		if (out !== undefined) {
			try {
				fs.closeSync(out);
			} catch {
				// ignore
			}
		}
	}
}

function looksLikeService(pid) {
	try {
		const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
		return /pi-weixin-connect/.test(cmdline);
	} catch {
		return true;
	}
}

/** SIGTERM 并等它退出（不自动 SIGKILL）。 */
export async function stopService(state, { timeoutMs = 10_000, intervalMs = 200, force = false } = {}) {
	if (!state || !isProcessAlive(state.pid)) return { stopped: true, reason: "already-exited" };
	if (!force && !isServiceAlive(state)) {
		return { stopped: false, reason: `pid ${state.pid} is alive but the heartbeat stopped; run /wx stop --force after confirming` };
	}
	if (force && !looksLikeService(state.pid)) {
		return { stopped: false, reason: `pid ${state.pid} does not look like pi-weixin-connect; refusing to force-kill` };
	}
	try {
		process.kill(state.pid, "SIGTERM");
	} catch (err) {
		return { stopped: false, reason: err?.message ?? String(err) };
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(state.pid)) return { stopped: true };
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return { stopped: false, reason: `process ${state.pid} did not exit within ${timeoutMs}ms` };
}

/** 当前进程是不是后台服务（launcher 注入 env，pi 的 ppid = launcher）。
 * 信任 env + ppid，不依赖状态文件：状态文件被删/写坏/被另一个 launcher 覆盖时，
 * 服务里的 Pi 仍然知道自己就是服务，否则它会把自己当控制面，再拉起一个嵌套服务。
 */
export function isServiceProcess() {
	const pid = process.env.PIWXCONNECT_SERVICE_PID;
	return Boolean(pid && String(process.ppid) === String(pid));
}

export function defaultCwd() {
	return os.homedir();
}

export function hasSystemdUnit() {
	return fs.existsSync(path.join(os.homedir(), ".config", "systemd", "user", "pi-weixin-connect.service"));
}

/**
 * 启动服务：装了 systemd 单元就交给 systemctl（日志进 journal、开机自启一致），
 * 否则 detached spawn。返回时尽量等到心跳上线。
 */
export async function startManagedService({ binPath, baseDir, cwd, sessionId = "pi-weixin-connect-service" }, { waitMs = 8000 } = {}) {
	const logFile = serviceLogPath(baseDir);
	let usedSystemd = false;
	if (hasSystemdUnit()) {
		const res = spawnSync("systemctl", ["--user", "start", "pi-weixin-connect.service"], {
			encoding: "utf8",
			timeout: 15_000,
		});
		const systemdError = res.error
			? res.error.message
			: res.status !== 0
				? (res.stderr || res.stdout || `systemctl exited with ${res.status}`).trim()
				: "";
		if (!systemdError) {
			usedSystemd = true;
		} else {
			// 容器 / 没有 user bus / 残留 unit：不要卡死在 systemd 上，退回 detached 启动
			const started = startService({ binPath, baseDir, cwd, sessionId });
			if (!started.pid) {
				return { pid: null, logFile, systemd: false, error: `${systemdError}; fallback start failed: ${started.error ?? "unknown reason"}` };
			}
		}
	} else {
		const started = startService({ binPath, baseDir, cwd, sessionId });
		if (!started.pid) return { ...started, systemd: false };
	}
	const stateFile = serviceStatePath(baseDir);
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const state = readServiceState(stateFile);
		if (state && isServiceAlive(state)) return { pid: state.pid, logFile, systemd: usedSystemd };
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { pid: null, logFile, systemd: usedSystemd, error: "service did not come online within 8s" };
}
