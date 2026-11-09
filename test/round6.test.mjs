/**
 * 第 6 轮审改的回归测试：协议超时、非 JSON 响应、baseUrl、分片、
 * 文件标记降级与配置提示。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WeixinApi } from "../src/api.js";
import { loadCredentials } from "../src/auth.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { Logger } from "../src/log.js";
import { parseFileMarkers } from "../src/media.js";
import { WeixinBridge } from "../src/session.js";
import { buildPrompt, chunkText, normalizeMessage } from "../src/text.js";
import { startMock } from "./mock-ilink.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 3000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fn()) return true;
		await sleep(20);
	}
	return false;
}

function rawMessage({ id = 1, from = "user-1", text = "你好", token = "ctx-1", at = Date.now() } = {}) {
	return {
		message_id: id,
		message_type: 1,
		message_state: 2,
		from_user_id: from,
		to_user_id: "bot-1",
		context_token: token,
		create_time_ms: at,
		item_list: [{ type: 1, text_item: { text } }],
	};
}

function makeBridge({ api, pi, config = {} }) {
	const cfg = {
		...DEFAULT_CONFIG,
		typing: false,
		...config,
		images: { ...DEFAULT_CONFIG.images },
		files: { ...DEFAULT_CONFIG.files, ...(config.files ?? {}) },
	};
	return new WeixinBridge({
		pi,
		api,
		config: cfg,
		log: new Logger({}),
		credentials: { token: "token-abc", userId: "user-1", botId: "bot-1" },
	});
}

/** 跑一轮完整的「注入 → 收集 → 回复」。 */
async function runTurn(bridge, mock, injected, reply) {
	bridge.enqueue(normalizeMessage(rawMessage()));
	assert.ok(await waitFor(() => injected.length === 1));
	bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
	bridge.onAgentStart();
	bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: reply }] });
	bridge.onAgentSettled(false);
	assert.ok(await waitFor(() => mock.sent.length > 0));
}

test("api：外部 signal 存在时 timeoutMs 仍然生效", async () => {
	const server = http.createServer(() => {});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const api = new WeixinApi({ baseUrl: `http://127.0.0.1:${port}` });
	const controller = new AbortController();
	const started = Date.now();
	try {
		await assert.rejects(api.getUpdates("t", "", { signal: controller.signal, timeoutMs: 200 }), /请求超时/);
		assert.ok(Date.now() - started < 2000);
	} finally {
		controller.abort();
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("api：200 但响应不是 JSON 视为失败，不返回空成功", async () => {
	const server = http.createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end("<html>portal</html>");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	const api = new WeixinApi({ baseUrl: `http://127.0.0.1:${port}` });
	try {
		await assert.rejects(api.getUpdates("t", ""), /响应不是 JSON/);
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
});

test("api：getupdates 的空响应不能被当成空成功", async () => {
	for (const body of ["", "{}"]) {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(body);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		const api = new WeixinApi({ baseUrl: `http://127.0.0.1:${port}` });
		try {
			await assert.rejects(api.getUpdates("t", ""), /空响应/);
		} finally {
			server.closeAllConnections?.();
			await new Promise((resolve) => server.close(resolve));
		}
	}
});

test("auth：凭证里的 baseUrl 只接受 http(s) 地址", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-r6-auth-"));
	const file = path.join(dir, "credentials.json");
	const old = process.env.PIWXCONNECT_CREDENTIALS;
	process.env.PIWXCONNECT_CREDENTIALS = file;
	try {
		fs.writeFileSync(file, JSON.stringify({ token: "t", baseUrl: "javascript:alert(1)" }));
		assert.equal(loadCredentials().baseUrl, "https://ilinkai.weixin.qq.com");

		fs.writeFileSync(file, JSON.stringify({ token: "t", baseUrl: "https://idc.example.com/" }));
		assert.equal(loadCredentials().baseUrl, "https://idc.example.com");
	} finally {
		if (old === undefined) delete process.env.PIWXCONNECT_CREDENTIALS;
		else process.env.PIWXCONNECT_CREDENTIALS = old;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("chunkText：切点不拆 emoji 代理对", () => {
	const text = "a".repeat(182) + "😀" + "b".repeat(300);
	const chunks = chunkText(text, { chunkChars: 200, maxChunks: 9 });
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
	}
});

test("buildPrompt：文件数量提示跟随 files.maxCount", () => {
	const item = { from: "user-1", text: "hi" };
	const prompt = buildPrompt(item, { files: { enabled: true, maxCount: 2 } }, []);
	assert.match(prompt.text, /最多 2 个/);
	assert.doesNotMatch(prompt.text, /最多 3 个/);
});

test("文件标记：files 关闭时剥离标记并给出原因", () => {
	const parsed = parseFileMarkers("结果 [[file:/tmp/x.txt]] 如下", { disabled: true });
	assert.equal(parsed.files.length, 0);
	assert.equal(parsed.skipped.length, 1);
	assert.match(parsed.skipped[0].reason, /文件发送已关闭/);
	assert.doesNotMatch(parsed.text, /\[\[file:/);

	const many = parseFileMarkers("[[file:/a]][[file:/b]][[file:/c]]", { disabled: true });
	assert.doesNotMatch(many.text, /\[\[file:/);
	assert.equal(many.skipped[0].count, 3);
});

test("bridge：files 关闭时不把 [[file:...]] 原样发到微信", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const bridge = makeBridge({
			api,
			pi: { sendUserMessage: (text) => injected.push(text) },
			config: { files: { enabled: false } },
		});
		await runTurn(bridge, mock, injected, "报告 [[file:/tmp/x.txt]] 如下");
		const text = mock.sent[0].msg.item_list[0].text_item.text;
		assert.doesNotMatch(text, /\[\[file:/);
		assert.match(text, /文件未发送/);
	} finally {
		await mock.close();
	}
});

test("bridge：只剩被拒绝的文件标记时也回一条说明", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const bridge = makeBridge({ api, pi: { sendUserMessage: (text) => injected.push(text) } });
		await runTurn(bridge, mock, injected, "[[file:/etc/passwd]]");
		assert.equal(mock.sent.length, 1);
		const text = mock.sent[0].msg.item_list[0].text_item.text;
		assert.match(text, /文件未发送/);
		assert.match(text, /敏感路径/);
	} finally {
		await mock.close();
	}
});
