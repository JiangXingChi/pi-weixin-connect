/**
 * 扩展入口的集成测试：独立服务在线时，控制面只当控制面，不重复拉起服务。
 * 用临时配置/凭证/状态目录，避免碰真实的 ~/.pi/agent。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import createExtension, { resetRuntimeForTests } from "../src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("index：后台服务在线时 session_start 不重复启动，status 标注承载方", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-index-"));
	const oldConfig = process.env.PIWXCONNECT_CONFIG;
	const oldCreds = process.env.PIWXCONNECT_CREDENTIALS;
	process.env.PIWXCONNECT_CONFIG = path.join(dir, "config.json");
	process.env.PIWXCONNECT_CREDENTIALS = path.join(dir, "credentials.json");

	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	try {
		fs.writeFileSync(process.env.PIWXCONNECT_CONFIG, "{}");
		fs.writeFileSync(
			process.env.PIWXCONNECT_CREDENTIALS,
			JSON.stringify({ token: "t", botId: "bot-1", userId: "user-1", baseUrl: "https://ilinkai.weixin.qq.com" }),
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(dir, "pi-weixin-connect.service.json"),
			JSON.stringify({
				pid: holder.pid,
				startedAt: new Date().toISOString(),
				heartbeatAt: new Date().toISOString(),
				sessionId: "pi-weixin-connect-service",
			}),
		);

		const handlers = {};
		const commands = {};
		const notes = [];
		const pi = {
			on: (name, fn) => {
				handlers[name] = fn;
			},
			registerCommand: (name, def) => {
				commands[name] = def;
			},
			sendUserMessage: () => {},
		};
		const ctx = { cwd: dir, ui: { notify: (message, level) => notes.push({ message, level }), setStatus: () => {} } };

		createExtension(pi);
		handlers.session_start({ reason: "startup" }, ctx);
		await sleep(400);

		assert.ok(!notes.some((n) => /正在重建/.test(n.message)), "不应误报会话重建");
		assert.ok(!notes.some((n) => /已自动启动/.test(n.message)), "不应重复拉起后台服务");

		await commands.wx.handler("status", ctx);
		const report = notes.at(-1)?.message ?? "";
		assert.match(report, /由后台服务承载/);
		assert.match(report, /已登录/);
	} finally {
		holder.kill("SIGKILL");
		if (oldConfig === undefined) delete process.env.PIWXCONNECT_CONFIG;
		else process.env.PIWXCONNECT_CONFIG = oldConfig;
		if (oldCreds === undefined) delete process.env.PIWXCONNECT_CREDENTIALS;
		else process.env.PIWXCONNECT_CREDENTIALS = oldCreds;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("index：进程活着但心跳过期时不双开服务，/wx start 也拒绝", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-index-stale-"));
	const oldConfig = process.env.PIWXCONNECT_CONFIG;
	const oldCreds = process.env.PIWXCONNECT_CREDENTIALS;
	process.env.PIWXCONNECT_CONFIG = path.join(dir, "config.json");
	process.env.PIWXCONNECT_CREDENTIALS = path.join(dir, "credentials.json");

	const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
	try {
		fs.writeFileSync(process.env.PIWXCONNECT_CONFIG, "{}");
		fs.writeFileSync(
			process.env.PIWXCONNECT_CREDENTIALS,
			JSON.stringify({ token: "t", botId: "bot-1", userId: "user-1", baseUrl: "https://ilinkai.weixin.qq.com" }),
			{ mode: 0o600 },
		);
		fs.writeFileSync(
			path.join(dir, "pi-weixin-connect.service.json"),
			JSON.stringify({
				pid: holder.pid,
				startedAt: new Date(Date.now() - 120_000).toISOString(),
				heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
				sessionId: "pi-weixin-connect-service",
			}),
		);

		resetRuntimeForTests();
		const handlers = {};
		const commands = {};
		const notes = [];
		const pi = {
			on: (name, fn) => {
				handlers[name] = fn;
			},
			registerCommand: (name, def) => {
				commands[name] = def;
			},
			sendUserMessage: () => {},
		};
		const ctx = { cwd: dir, ui: { notify: (message, level) => notes.push({ message, level }), setStatus: () => {} } };

		createExtension(pi);
		handlers.session_start({ reason: "startup" }, ctx);
		await sleep(300);
		assert.ok(notes.some((n) => /心跳已停/.test(n.message)), "应提示服务进程还在但心跳过期");
		assert.ok(!notes.some((n) => /已自动启动/.test(n.message)), "不应双开服务");

		await commands.wx.handler("start", ctx);
		assert.match(notes.at(-1)?.message ?? "", /心跳已停/);
	} finally {
		holder.kill("SIGKILL");
		resetRuntimeForTests();
		if (oldConfig === undefined) delete process.env.PIWXCONNECT_CONFIG;
		else process.env.PIWXCONNECT_CONFIG = oldConfig;
		if (oldCreds === undefined) delete process.env.PIWXCONNECT_CREDENTIALS;
		else process.env.PIWXCONNECT_CREDENTIALS = oldCreds;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
