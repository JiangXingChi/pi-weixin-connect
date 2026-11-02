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
	if (!state) return "未运行";
	const alive = isProcessAlive(state.pid);
	const fresh = isServiceAlive(state, { now, staleMs });
	const parsed = Date.parse(state.heartbeatAt ?? "");
	const beat = Number.isFinite(parsed) ? Math.round((now - parsed) / 1000) : null;
	const detail = !alive ? "进程已退出" : fresh ? "在线" : beat === null ? "心跳时间未知" : `心跳停了 ${beat}s`;
	return `pid ${state.pid} · ${detail} · 会话 ${state.sessionId ?? "?"}`;
}

/** 拉起后台服务（detached，父进程退出后仍在）。 */
export function startService({ binPath, baseDir, cwd, sessionId = "pi-weixin-connect-service", nodePath = process.execPath }) {
	const logFile = serviceLogPath(baseDir);
	if (!fs.existsSync(binPath)) return { pid: null, logFile, error: `找不到启动脚本：${binPath}` };
	if (!fs.existsSync(cwd)) return { pid: null, logFile, error: `工作目录不存在：${cwd}` };
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	try {
		if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
	} catch {
		// ignore
	}
	let out;
	try {
		out = fs.openSync(logFile, "a");
		const child = spawn(nodePath, [binPath, "--cwd", cwd, "--session-id", sessionId], {
			cwd,
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...process.env },
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
		return { stopped: false, reason: `pid ${state.pid} 还活着但心跳已停，确认后用 /wx stop --force` };
	}
	if (force && !looksLikeService(state.pid)) {
		return { stopped: false, reason: `pid ${state.pid} 看起来不是 pi-weixin-connect，拒绝强制结束` };
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
	return { stopped: false, reason: `进程 ${state.pid} 在 ${timeoutMs}ms 内没有退出` };
}

/** 当前进程是不是状态文件里那个后台服务（launcher 注入 env，pi 的 ppid = launcher）。 */
export function isServiceProcess(state) {
	return Boolean(
		process.env.PIWXCONNECT_SERVICE_PID &&
			state &&
			String(state.pid) === process.env.PIWXCONNECT_SERVICE_PID &&
			process.ppid === state.pid,
	);
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
	let error;
	if (hasSystemdUnit()) {
		const res = spawnSync("systemctl", ["--user", "start", "pi-weixin-connect.service"], {
			encoding: "utf8",
			timeout: 15_000,
		});
		if (res.error) error = res.error.message;
		else if (res.status !== 0) error = (res.stderr || res.stdout || `systemctl 退出码 ${res.status}`).trim();
		if (error) return { pid: null, logFile, systemd: true, error };
	} else {
		const started = startService({ binPath, baseDir, cwd, sessionId });
		if (!started.pid) return { ...started, systemd: false };
	}
	const stateFile = serviceStatePath(baseDir);
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const state = readServiceState(stateFile);
		if (state && isServiceAlive(state)) return { pid: state.pid, logFile, systemd: hasSystemdUnit() };
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { pid: null, logFile, systemd: hasSystemdUnit(), error: "服务没有在 8 秒内上线" };
}
