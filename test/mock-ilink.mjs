/**
 * 假 iLink 服务端：覆盖扫码状态机、长轮询、发消息、typing。
 * 只实现 P0 用到的端点。
 */

import http from "node:http";

export async function startMock({
	qr = "qr-test-1",
	statusSequence = ["wait", "scaned", "confirmed"],
	messages = [],
	expired = false,
	failSendTimes = 0,
} = {}) {
	const state = {
		status: [...statusSequence],
		messages: [...messages],
		expired,
		failSendTimes,
		sent: [],
		typing: [],
		notify: [],
		getUpdatesCalls: 0,
		verifyCodes: [],
		authorization: [],
		uploads: [],
		uploadRequests: [],
		downloads: new Map(),
	};

	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		const chunks = [];
		req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		req.on("end", () => {
			const bodyBuf = Buffer.concat(chunks);
			const body = bodyBuf.toString("utf8");
			const send = (code, payload) => {
				res.writeHead(code, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			const auth = req.headers.authorization ?? "";
			if (auth) state.authorization.push(auth);
			let json = {};
			try {
				json = body ? JSON.parse(body) : {};
			} catch {
				json = {};
			}

			if (req.method === "POST" && url.pathname === "/ilink/bot/get_bot_qrcode") {
				return send(200, { ret: 0, qrcode: qr, qrcode_img_content: "https://liteapp.weixin.qq.com/q/test" });
			}
			if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
				const code = url.searchParams.get("verify_code");
				if (code) state.verifyCodes.push(code);
				let status = state.status.shift() ?? "wait";
				if (status === "need_verifycode" && code) status = "scaned";
				if (status === "confirmed") {
					return send(200, {
						ret: 0,
						status,
						bot_token: "token-abc",
						ilink_bot_id: "bot-1",
						ilink_user_id: "user-1",
						baseurl: state.baseUrl,
					});
				}
				return send(200, { ret: 0, status });
			}
			if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
				state.getUpdatesCalls++;
				if (state.expired) return send(200, { ret: 0, errcode: -14, errmsg: "expired" });
				if (state.messages.length > 0) {
					const msgs = state.messages.splice(0, state.messages.length);
					return send(200, { ret: 0, msgs, get_updates_buf: `buf-${state.getUpdatesCalls}`, longpolling_timeout_ms: 1 });
				}
				return send(200, { ret: 0, msgs: [], get_updates_buf: `buf-${state.getUpdatesCalls}`, longpolling_timeout_ms: 1 });
			}
			if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
				if (state.failSendTimes > 0) {
					state.failSendTimes--;
					return send(500, { ret: -1, errmsg: "temporary" });
				}
				state.sent.push(json);
				return send(200, { ret: 0, errmsg: "" });
			}
			if (req.method === "POST" && url.pathname === "/ilink/bot/getuploadurl") {
				state.uploadRequests.push(json);
				return send(200, { ret: 0, upload_full_url: `${state.baseUrl}/cdn/upload`, upload_param: "up-param" });
			}
			if (req.method === "POST" && url.pathname === "/cdn/upload") {
				state.uploads.push({ size: bodyBuf.length, filekey: url.searchParams.get("filekey") });
				res.writeHead(200, { "x-encrypted-param": "download-param-1", "Content-Type": "application/octet-stream" });
				return res.end();
			}
			if (req.method === "GET" && url.pathname === "/cdn/download") {
				const key = url.searchParams.get("encrypted_query_param");
				const buf = state.downloads.get(key);
				if (!buf) return send(404, { ret: -1, errmsg: "no media" });
				res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": buf.length });
				return res.end(buf);
			}
			if (req.method === "POST" && url.pathname === "/ilink/bot/getconfig") {
				return send(200, { ret: 0, typing_ticket: "ticket-1" });
			}
			if (req.method === "POST" && url.pathname === "/ilink/bot/sendtyping") {
				state.typing.push(json);
				return send(200, { ret: 0 });
			}
			if (req.method === "POST" && (url.pathname === "/ilink/bot/msg/notifystart" || url.pathname === "/ilink/bot/msg/notifystop")) {
				state.notify.push(url.pathname);
				return send(200, { ret: 0 });
			}
			return send(404, { ret: -1, errmsg: `no route ${req.method} ${url.pathname}` });
		});
	});

	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	state.baseUrl = `http://127.0.0.1:${port}`;
	state.close = () => new Promise((resolve) => server.close(resolve));
	return state;
}
