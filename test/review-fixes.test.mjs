/**
 * 第 1 轮审改的回归测试。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WeixinApi } from "../src/api.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { Logger } from "../src/log.js";
import { inspectFile } from "../src/media.js";
import { WeixinBridge } from "../src/session.js";
import { chunkText, isAllowed, normalizeMessage } from "../src/text.js";
import { startMock } from "./mock-ilink.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 4000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fn()) return true;
		await sleep(20);
	}
	return false;
}

function rawMessage({ id = 1, from = "user-1", text = "你好", token = "ctx-1", at = Date.now(), state = 2 } = {}) {
	return {
		message_id: id,
		message_type: 1,
		message_state: state,
		from_user_id: from,
		to_user_id: "bot-1",
		context_token: token,
		create_time_ms: at,
		item_list: [{ type: 1, text_item: { text } }],
	};
}

function makeBridge({ api, pi, config = {}, typing = false }) {
	const cfg = {
		...DEFAULT_CONFIG,
		typing,
		...config,
		images: { ...DEFAULT_CONFIG.images },
		files: { ...DEFAULT_CONFIG.files },
	};
	return new WeixinBridge({
		pi,
		api,
		config: cfg,
		log: new Logger({}),
		credentials: { token: "token-abc", userId: "user-1", botId: "bot-1" },
	});
}

test("isAllowed：不知道登录者时拒绝所有人", () => {
	assert.equal(isAllowed({ kind: "private", from: "user-1" }, { allowUsers: [] }, ""), false);
	assert.equal(isAllowed({ kind: "private", from: "user-1" }, { allowUsers: [] }, null), false);
});

test("normalizeMessage：忽略生成中（state=1）的消息", () => {
	assert.equal(normalizeMessage(rawMessage({ state: 1 })), null);
	assert.ok(normalizeMessage(rawMessage({ state: 2 })));
});

test("chunkText：整 4000 字仍是一条；超长时分片不越界", () => {
	const exact = "x".repeat(4000);
	assert.equal(chunkText(exact, { chunkChars: 4000, maxChunks: 9 }).length, 1);
	const long = "y".repeat(4001);
	const chunks = chunkText(long, { chunkChars: 4000, maxChunks: 9 });
	assert.ok(chunks.length >= 2);
	for (const chunk of chunks) assert.ok(chunk.length <= 4000, `too long: ${chunk.length}`);
});

test("inspectFile：allowDirs 不能绕过敏感目录与软链", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-deny-"));
	try {
		const ssh = path.join(os.homedir(), ".ssh");
		const sshExisted = fs.existsSync(ssh);
		fs.mkdirSync(ssh, { recursive: true });
		const secret = path.join(ssh, `piwx-test-${process.pid}`);
		fs.writeFileSync(secret, "secret");
		try {
			// allowDirs 指向 home，仍必须拒绝 ~/.ssh
			const direct = inspectFile(secret, { allowDirs: [os.homedir()] });
			assert.equal(direct.ok, false);
			assert.match(direct.reason, /敏感路径/);

			const link = path.join(dir, "link.txt");
			fs.symlinkSync(secret, link);
			const viaLink = inspectFile(link, { allowDirs: [dir] });
			assert.equal(viaLink.ok, false);
			assert.match(viaLink.reason, /敏感路径/);
		} finally {
			fs.rmSync(secret, { force: true });
			if (!sshExisted) fs.rmSync(ssh, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("config：字符串 false 不再被当成 true", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-cfg-"));
	const old = process.env.PIWXCONNECT_CONFIG;
	try {
		const file = path.join(dir, "config.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ enabled: "false", typing: "false", lock: "false", images: { enabled: "false" }, files: { enabled: "false" } }),
		);
		process.env.PIWXCONNECT_CONFIG = file;
		const { config } = loadConfig();
		assert.equal(config.enabled, false);
		assert.equal(config.typing, false);
		assert.equal(config.lock, false);
		assert.equal(config.images.enabled, false);
		assert.equal(config.files.enabled, false);
	} finally {
		if (old === undefined) delete process.env.PIWXCONNECT_CONFIG;
		else process.env.PIWXCONNECT_CONFIG = old;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bridge：本轮没有正常开始时不卡死，消息放回队列重试", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		bridge.enqueue(normalizeMessage(rawMessage()));
		assert.ok(await waitFor(() => injected.length === 1));

		// 模拟 Pi 没有触发 before_agent_start 就 agent_settled
		bridge.onAgentStart();
		bridge.onAgentSettled(false);
		assert.ok(await waitFor(() => injected.length === 2, 5000), "应当重新注入");
		assert.equal(bridge.inflight?.started, false);
	} finally {
		await mock.close();
	}
});

test("bridge：发送 5xx 会重试，最终送达", async () => {
	const mock = await startMock({ failSendTimes: 1 });
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		bridge.enqueue(normalizeMessage(rawMessage()));
		assert.ok(await waitFor(() => injected.length === 1));
		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "pong" }] });
		bridge.onAgentSettled(false);

		assert.ok(await waitFor(() => mock.sent.length === 1, 5000));
		assert.equal(mock.sent[0].msg.item_list[0].text_item.text, "pong");
	} finally {
		await mock.close();
	}
});

test("bridge：typing 开始后一定收尾", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi, typing: true });
		bridge.enqueue(normalizeMessage(rawMessage()));
		assert.ok(await waitFor(() => injected.length === 1));
		assert.ok(await waitFor(() => mock.typing.some((entry) => entry.status === 1)));

		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "pong" }] });
		bridge.onAgentSettled(false);

		assert.ok(await waitFor(() => mock.sent.length === 1));
		assert.ok(await waitFor(() => mock.typing.some((entry) => entry.status === 2)));
	} finally {
		await mock.close();
	}
});

test("bridge：同一 message_id 即使时间戳不同也只处理一次", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		assert.equal(bridge.enqueue(normalizeMessage(rawMessage({ id: 5, at: 1000 }))).accepted, true);
		assert.equal(bridge.enqueue(normalizeMessage(rawMessage({ id: 5, at: 9999 }))).accepted, false);
	} finally {
		await mock.close();
	}
});

test("bridge：切换期间暂存也有上限", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const pi = { sendUserMessage: () => {} };
		const bridge = makeBridge({ api, pi, config: { maxQueue: 1 } });
		bridge.beginSwitch();
		assert.equal(bridge.enqueue(normalizeMessage(rawMessage({ id: 1 }))).accepted, true);
		const second = bridge.enqueue(normalizeMessage(rawMessage({ id: 2 })));
		assert.equal(second.accepted, false);
		assert.equal(second.reason, "queue-full");
	} finally {
		await mock.close();
	}
});
