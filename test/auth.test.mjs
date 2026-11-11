import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WeixinApi } from "../src/api.js";
import { login } from "../src/auth.js";
import { startMock } from "./mock-ilink.mjs";

function tmpEnv() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-auth-"));
	process.env.PIWXCONNECT_CREDENTIALS = path.join(dir, "credentials.json");
	process.env.PIWXCONNECT_QR_DIR = path.join(dir, "qr");
	return dir;
}

test("login：wait → need_verifycode → confirmed，凭证 0600 落盘", async () => {
	const dir = tmpEnv();
	const mock = await startMock({ statusSequence: ["wait", "need_verifycode", "scaned", "confirmed"] });
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		let qrShown = 0;
		let codeAsked = 0;
		const credentials = await login({
			api,
			onQr: () => qrShown++,
			onNeedVerifyCode: async () => {
				codeAsked++;
				return "1234";
			},
		});
		assert.equal(qrShown, 1);
		assert.equal(codeAsked, 1);
		assert.ok(mock.verifyCodes.includes("1234"));
		assert.equal(credentials.token, "token-abc");
		assert.equal(credentials.userId, "user-1");
		assert.equal(credentials.baseUrl, mock.baseUrl);
		assert.ok(fs.existsSync(process.env.PIWXCONNECT_CREDENTIALS));
		const mode = fs.statSync(process.env.PIWXCONNECT_CREDENTIALS).mode & 0o777;
		assert.equal(mode, 0o600);
	} finally {
		await mock.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("login：verify_code_blocked 直接失败", async () => {
	const dir = tmpEnv();
	const mock = await startMock({ statusSequence: ["scaned", "verify_code_blocked"] });
	try {
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		await assert.rejects(
			login({ api, onNeedVerifyCode: async () => "0000" }),
			/too many wrong pairing codes/,
		);
	} finally {
		await mock.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
