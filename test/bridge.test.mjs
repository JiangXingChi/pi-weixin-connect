import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WeixinApi } from "../src/api.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { Logger } from "../src/log.js";
import { WeixinBridge } from "../src/session.js";
import { normalizeMessage } from "../src/text.js";
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

test("bridge：注入 → 收集 → 带 context_token 回复", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });

		const raw = rawMessage();
		const item = normalizeMessage(raw);
		assert.equal(bridge.enqueue(item).accepted, true);
		assert.ok(await waitFor(() => injected.length === 1));
		assert.match(injected[0], /\[微信单聊 · 用户 user-1\]\n你好/);

		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "pong" }] });
		bridge.onAgentSettled(false);

		assert.ok(await waitFor(() => mock.sent.length === 1));
		const msg = mock.sent[0].msg;
		assert.equal(msg.to_user_id, "user-1");
		assert.equal(msg.context_token, "ctx-1");
		assert.equal(msg.item_list[0].text_item.text, "pong");
		assert.equal(mock.sent[0].base_info.channel_version, "0.1.0");

		// 去重：同一 message_id + 时间戳再入队不生效
		assert.equal(bridge.enqueue(normalizeMessage(raw)).accepted, false);
	} finally {
		await mock.close();
	}
});

test("bridge：非白名单用户被忽略", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const pi = { sendUserMessage: () => assert.fail("不应注入") };
		const bridge = makeBridge({ api, pi, config: { allowUsers: ["someone-else"] } });
		const result = bridge.enqueue(normalizeMessage(rawMessage({ from: "stranger" })));
		assert.equal(result.accepted, false);
		assert.equal(result.reason, "not-allowed");
	} finally {
		await mock.close();
	}
});

test("bridge：超长回答按预算 9 条截断", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		bridge.enqueue(normalizeMessage(rawMessage()));
		assert.ok(await waitFor(() => injected.length === 1));

		const long = Array.from({ length: 15 }, (_, i) => `第${i + 1}段` + "x".repeat(3800)).join("\n\n");
		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: long }] });
		bridge.onAgentSettled(false);

		assert.ok(await waitFor(() => mock.sent.length >= 9));
		assert.equal(mock.sent.length, 9);
		for (const sent of mock.sent) assert.ok(sent.msg.item_list[0].text_item.text.length <= 4000);
		assert.match(mock.sent[8].msg.item_list[0].text_item.text, /\.\.\. \(truncated, message too long\)$/);
	} finally {
		await mock.close();
	}
});

test("bridge：超过 24 小时窗口不发", async () => {
	const mock = await startMock();
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		const old = Date.now() - 25 * 3600_000;
		bridge.enqueue(normalizeMessage(rawMessage({ at: old })));
		assert.ok(await waitFor(() => injected.length === 1));
		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "pong" }] });
		bridge.onAgentSettled(false);
		await sleep(300);
		assert.equal(mock.sent.length, 0);
	} finally {
		await mock.close();
	}
});

test("bridge：入站图片解密后作为 Pi 图片输入", async () => {
	const mock = await startMock();
	const key = crypto.randomBytes(16);
	try {
		// 一段带 PNG 文件头的假图片，AES 加密后放到 CDN
		const plain = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(64)]);
		const cipher = (await import("../src/media.js")).encryptAesEcb(plain, key);
		mock.downloads.set("img-param", cipher);

		const raw = {
			message_id: 99,
			message_type: 1,
			from_user_id: "user-1",
			context_token: "ctx-9",
			create_time_ms: Date.now(),
			item_list: [
				{ type: 1, text_item: { text: "看这张图" } },
				{
					type: 2,
					image_item: {
						media: {
							encrypt_query_param: "img-param",
							full_url: `${mock.baseUrl}/cdn/download?encrypted_query_param=img-param`,
							aes_key: Buffer.from(key.toString("hex"), "utf8").toString("base64"),
						},
					},
				},
			],
		};
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (content) => injected.push(content) };
		const bridge = makeBridge({ api, pi });
		assert.equal(bridge.enqueue(normalizeMessage(raw)).accepted, true);
		assert.ok(await waitFor(() => injected.length === 1));

		const content = injected[0];
		assert.ok(Array.isArray(content));
		assert.equal(content[0].type, "text");
		assert.match(content[0].text, /看这张图/);
		assert.equal(content[1].type, "image");
		assert.equal(content[1].mimeType, "image/png");
		assert.deepEqual(Buffer.from(content[1].data, "base64"), plain);
	} finally {
		await mock.close();
	}
});

test("bridge：回复里的 [[file:...]] 上传并作为文件消息发送", async () => {
	const mock = await startMock();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-out-"));
	try {
		const file = path.join(dir, "report.txt");
		fs.writeFileSync(file, "报告内容");

		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const injected = [];
		const pi = { sendUserMessage: (text) => injected.push(text) };
		const bridge = makeBridge({ api, pi });
		bridge.enqueue(normalizeMessage(rawMessage()));
		assert.ok(await waitFor(() => injected.length === 1));

		bridge.onBeforeAgentStart({ messageType: "user", prompt: injected[0] });
		bridge.onAgentStart();
		bridge.onMessageEnd({
			role: "assistant",
			content: [{ type: "text", text: `报告写好了\n[[file:${file}]]` }],
		});
		bridge.onAgentSettled(false);

		assert.ok(await waitFor(() => mock.sent.length === 2));
		const textMsg = mock.sent[0].msg;
		assert.equal(textMsg.item_list[0].type, 1);
		assert.match(textMsg.item_list[0].text_item.text, /报告写好了/);
		assert.doesNotMatch(textMsg.item_list[0].text_item.text, /\[\[file:/);

		const mediaMsg = mock.sent[1].msg;
		const item = mediaMsg.item_list[0];
		assert.equal(item.type, 4);
		assert.equal(item.file_item.file_name, "report.txt");
		assert.equal(item.file_item.len, "12");
		assert.equal(item.file_item.media.encrypt_query_param, "download-param-1");
		assert.equal(mock.uploads.length, 1);
		assert.equal(mock.uploads[0].size, 16);
	} finally {
		await mock.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
