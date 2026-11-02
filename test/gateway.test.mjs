import assert from "node:assert/strict";
import test from "node:test";

import { WeixinApi } from "../src/api.js";
import { Logger } from "../src/log.js";
import { WeixinGateway } from "../src/gateway.js";
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

test("gateway：收消息并归一化", async () => {
	const mock = await startMock({
		messages: [
			{
				message_id: 7,
				message_type: 1,
				from_user_id: "user-1",
				context_token: "ctx-7",
				create_time_ms: Date.now(),
				item_list: [{ type: 1, text_item: { text: "ping" } }],
			},
		],
	});
	const api = new WeixinApi({ baseUrl: mock.baseUrl });
	const received = [];
	const states = [];
	const gw = new WeixinGateway({
		api,
		token: "token-abc",
		userId: "user-1",
		log: new Logger({}),
		onMessage: (item) => received.push(item),
		onState: (s) => states.push(s),
	});
	try {
		await gw.start();
		assert.ok(await waitFor(() => received.length === 1));
		assert.equal(received[0].text, "ping");
		assert.equal(received[0].contextToken, "ctx-7");
		assert.ok(states.includes("connected"));
	} finally {
		gw.stop();
		await mock.close();
	}
});

test("gateway：-14 触发 onExpired，不再轮询", async () => {
	const mock = await startMock({ expired: true });
	const api = new WeixinApi({ baseUrl: mock.baseUrl });
	let expired = 0;
	const gw = new WeixinGateway({
		api,
		token: "token-abc",
		userId: "user-1",
		log: new Logger({}),
		onMessage: () => {},
		onExpired: () => expired++,
	});
	try {
		await gw.start();
		assert.ok(await waitFor(() => expired === 1));
		assert.equal(gw.state, "expired");
	} finally {
		gw.stop();
		await mock.close();
	}
});
