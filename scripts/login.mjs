#!/usr/bin/env node
/**
 * 扫码登录 CLI（P0 验证用，也是 /wx login 在非 TUI 环境下的兜底）。
 *
 * 用法：node scripts/login.mjs [--force]
 * 成功后凭证写入 ~/.pi/agent/.pi-weixin/credentials.json（0600）。
 */

import readline from "node:readline/promises";
import fs from "node:fs";
import { stdin as input, stdout as output } from "node:process";

import {
	backupCredentials,
	dropCredentialsBackup,
	loadCredentials,
	login,
	restoreCredentials,
} from "../src/auth.js";
import { credentialsPath, loadConfig } from "../src/config.js";
import { WeixinApi } from "../src/api.js";
import { Logger } from "../src/log.js";

const force = process.argv.includes("--force");
const { config } = loadConfig();
const logger = new Logger({ ...config.log, level: process.env.PIWXCONNECT_LOG_LEVEL || "info" });
const VERSION = (() => {
	try {
		return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
})();

let backup = null;
if (force) {
	backup = backupCredentials();
	console.log(backup ? "已备份旧凭证" : "没有旧凭证");
} else if (loadCredentials()) {
	console.log("已有凭证；要重新扫码请加 --force");
	process.exit(0);
}

const api = new WeixinApi({
	baseUrl: config.endpoints.base,
	cdnBaseUrl: config.endpoints.cdn,
	version: VERSION,
	log: logger,
});

const rl = readline.createInterface({ input, output });
try {
	const credentials = await login({
		api,
		log: logger,
		onQr: (qr) => {
			if (qr.ansi) {
				process.stdout.write(qr.ansi + "\n");
			} else {
				console.log(`二维码内容：${qr.content}`);
			}
			if (qr.pngPath) console.log(`二维码图片：${qr.pngPath}`);
			console.log(`二维码链接：${qr.url}`);
			console.log("请用微信扫码并在手机上确认。");
		},
		onStatus: (text) => console.log(text),
		onNeedVerifyCode: async () => rl.question("请输入手机微信上显示的配对码："),
	});
	dropCredentialsBackup(backup);
	console.log(`登录成功：bot=${credentials.botId || "?"} user=${credentials.userId || "?"}`);
	console.log(`凭证：${credentialsPath()}`);
} catch (err) {
	restoreCredentials(backup);
	console.error(`登录失败：${err?.message ?? err}`);
	process.exitCode = 1;
} finally {
	rl.close();
}
