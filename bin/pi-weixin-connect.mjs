#!/usr/bin/env node
/**
 * 微信桥常驻启动器：拉起 `pi --mode rpc`（只挂本扩展），保持 stdin 不关。
 *
 * 用法：
 *   ./bin/pi-weixin-connect.mjs
 *   ./bin/pi-weixin-connect.mjs --cwd ~ --session-id pi-weixin-connect-service
 *   ./bin/pi-weixin-connect.mjs --model opencode-go/deepseek-v4.1-flash
 *   ./bin/pi-weixin-connect.mjs --no-restart
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configPath, loadConfig } from "../src/config.js";
import {
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	writeServiceState,
} from "../src/service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const baseDir = path.dirname(configPath());
const stateFile = serviceStatePath(baseDir);

function arg(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = process.argv[index + 1];
	return value && !value.startsWith("--") ? value : fallback;
}

const sessionId = arg("session-id", "pi-weixin-connect-service");
const cwd = arg("cwd", process.cwd());
const model = arg("model", "");
const provider = arg("provider", "");
const restart = !process.argv.includes("--no-restart");
const dryRun = process.argv.includes("--dry-run");

let child;
let stopping = false;
let restartDelay = 3000;
let startedAt = 0;
const startedIso = new Date().toISOString();

function beat() {
	try {
		writeServiceState(stateFile, {
			pid: process.pid,
			startedAt: startedIso,
			heartbeatAt: new Date().toISOString(),
			sessionId: String(sessionId),
			cwd: String(cwd),
			version: pkg.version,
		});
	} catch {
		// 状态文件写不进去不影响机器人
	}
}

function scheduleRestart() {
	restartDelay = Date.now() - startedAt > 60_000 ? 3000 : Math.min(restartDelay * 2, 60_000);
	if (restart) {
		setTimeout(launch, restartDelay);
	} else {
		console.error("[pi-weixin-connect] --no-restart：服务结束");
		removeServiceState(stateFile);
		process.exit(0);
	}
}

/** RPC 对话框在后台没人应答；不排空 stdout 会阻塞 pi。 */
function pumpStdout(stream) {
	let buffer = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			if (record?.type !== "extension_ui_request") continue;
			if (!["select", "confirm", "input", "editor"].includes(record.method)) continue;
			console.error(`[pi-weixin-connect] 后台收到交互请求（${record.method}），自动取消`);
			try {
				child?.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: record.id, cancelled: true })}\n`);
			} catch {
				// child gone
			}
		}
	});
	stream.on("error", () => {});
}

function buildPlan() {
	loadConfig();
	const args = ["--mode", "rpc", "--session-id", String(sessionId), "--no-extensions", "--extension", root];
	if (provider) args.push("--provider", provider);
	if (model) args.push("--model", model);
	return args;
}

function launch() {
	const args = buildPlan();
	console.error(`[pi-weixin-connect] 启动：pi ${args.join(" ")}（cwd=${cwd}）`);
	startedAt = Date.now();
	let launched;
	try {
		launched = spawn("pi", args, {
			cwd: String(cwd),
			stdio: ["pipe", "pipe", "inherit"],
			env: { ...process.env, PIWXCONNECT_SERVICE_PID: String(process.pid) },
		});
	} catch (err) {
		console.error(`[pi-weixin-connect] 无法启动 pi：${err.message}`);
		scheduleRestart();
		return;
	}
	if (launched.stdout) pumpStdout(launched.stdout);
	child = launched;
	let ended = false;
	const onEnd = (why) => {
		if (ended) return;
		ended = true;
		child = undefined;
		if (stopping) return;
		console.error(`[pi-weixin-connect] pi ${why}`);
		scheduleRestart();
	};
	launched.once("exit", (code, signal) => onEnd(`退出（code=${code} signal=${signal}）`));
	launched.once("error", (err) => onEnd(`无法启动：${err.message}`));
	launched.once("close", (code) => onEnd(`关闭（code=${code}）`));
}

function shutdown(signal) {
	stopping = true;
	console.error(`[pi-weixin-connect] 收到 ${signal}，停止`);
	try {
		child?.stdin?.end();
		child?.kill("SIGTERM");
	} catch {
		// ignore
	}
	const waiter = setInterval(() => {
		if (!child) {
			clearInterval(waiter);
			process.exit(0);
		}
	}, 100);
	waiter.unref?.();
	setTimeout(() => {
		if (child) {
			console.error("[pi-weixin-connect] 子进程 8 秒内未退出，强制结束");
			try {
				child.kill("SIGKILL");
			} catch {
				// ignore
			}
		}
		process.exit(0);
	}, 8000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => removeServiceState(stateFile));

if (dryRun) {
	console.log(JSON.stringify({ cwd, args: buildPlan() }, null, 2));
	process.exit(0);
}

// 已有健康服务时直接退出，避免两个 pi 抢长轮询
const existing = readServiceState(stateFile);
if (existing && existing.pid !== process.pid && isServiceAlive(existing)) {
	console.error(`[pi-weixin-connect] 已有后台服务在运行（pid ${existing.pid}），本进程退出`);
	process.exit(process.env.INVOCATION_ID ? 1 : 0);
}

beat();
setInterval(beat, 15_000);
launch();
