/**
 * 扫码登录 + 凭证持久化。
 *
 * 流程（对齐腾讯 openclaw-weixin 的 login-qr）：
 *   取二维码 → 轮询状态 → wait/scaned → confirmed
 * 额外状态：expired（重取）、need_verifycode（手机上的配对码）、
 *          scaned_but_redirect（换 IDC 域名）、verify_code_blocked（重取或停止）、
 *          binded_redirect（已绑定，直接复用本地凭证）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { credentialsPath } from "./config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** 只接受 http(s) 绝对地址；凭证文件被改写时不把 token 发到奇怪的地方。 */
export function safeBaseUrl(value) {
	const raw = String(value ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\/[^\s/?#]+/i.test(raw)) return "";
	return raw;
}

export function loadCredentials() {
	try {
		const data = JSON.parse(fs.readFileSync(credentialsPath(), "utf8"));
		if (!data || typeof data.token !== "string" || !data.token) return null;
		return {
			token: data.token,
			botId: data.botId ?? data.ilink_bot_id ?? "",
			userId: data.userId ?? data.ilink_user_id ?? "",
			baseUrl: safeBaseUrl(data.baseUrl ?? data.baseurl) || DEFAULT_BASE_URL,
			savedAt: data.savedAt ?? "",
		};
	} catch {
		return null;
	}
}

export function saveCredentials(credentials) {
	const file = credentialsPath();
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const payload = JSON.stringify(
		{
			token: credentials.token,
			botId: credentials.botId ?? "",
			userId: credentials.userId ?? "",
			baseUrl: safeBaseUrl(credentials.baseUrl) || DEFAULT_BASE_URL,
			savedAt: new Date().toISOString(),
		},
		null,
		2,
	);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, payload, { mode: 0o600 });
	fs.renameSync(tmp, file);
	try {
		fs.chmodSync(file, 0o600);
	} catch {
		// ignore
	}
}

export function clearCredentials() {
	try {
		fs.unlinkSync(credentialsPath());
	} catch {
		// ignore
	}
}

/** 强制重扫前备份现有凭证；返回备份路径（没有凭证时返回 null）。 */
export function backupCredentials() {
	try {
		const src = credentialsPath();
		if (!fs.existsSync(src)) return null;
		const dst = `${src}.bak-${Date.now()}`;
		fs.renameSync(src, dst);
		return dst;
	} catch {
		return null;
	}
}

export function restoreCredentials(backup) {
	if (!backup) return;
	try {
		if (fs.existsSync(backup)) fs.renameSync(backup, credentialsPath());
	} catch {
		// ignore
	}
}

export function dropCredentialsBackup(backup) {
	if (!backup) return;
	try {
		fs.rmSync(backup, { force: true });
	} catch {
		// ignore
	}
}

/**
 * 把二维码内容渲染成 PNG 与终端 ANSI。
 * 本机有 qrencode；没有时只返回原始内容，由调用方提示。
 */
export function qrDir() {
	// 默认 /tmp：~/.pi/agent 是 pi-qq-connect 的出站敏感目录，放那里 QQ 里发不出去
	return process.env.PIWXCONNECT_QR_DIR || path.join(os.tmpdir(), "pi-weixin-connect");
}

export function renderQr(content, { dir = qrDir() } = {}) {
	const pngPath = path.join(dir, "qr.png");
	let ansi = "";
	try {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		fs.rmSync(pngPath, { force: true });
		const png = spawnSync("qrencode", ["-t", "PNG", "-o", pngPath, "-s", "6", "-m", "2", String(content)], {
			encoding: "utf8",
			timeout: 10_000,
		});
		if (png.error || png.status !== 0) {
			fs.rmSync(pngPath, { force: true });
		} else {
			fs.chmodSync(pngPath, 0o600);
		}
		const text = spawnSync("qrencode", ["-t", "ANSIUTF8", "-m", "1", "-o", "-", String(content)], {
			encoding: "utf8",
			timeout: 10_000,
		});
		if (!text.error && text.status === 0) ansi = text.stdout ?? "";
	} catch {
		// 没有 qrencode 时交给调用方显示 URL
	}
	const exists = fs.existsSync(pngPath);
	return { pngPath: exists ? pngPath : null, ansi, content: String(content) };
}

/**
 * 扫码登录。成功后返回并保存凭证。
 *
 * @param {object} opts
 * @param {import('./api.js').WeixinApi} opts.api
 * @param {object} [opts.log]
 * @param {(qr:{content:string,pngPath:string|null,ansi:string})=>void} [opts.onQr]
 * @param {(text:string)=>void} [opts.onStatus]
 * @param {()=>Promise<string|null>} [opts.onNeedVerifyCode] 返回 null 表示放弃
 * @param {AbortSignal} [opts.signal]
 */
export async function login({
	api,
	log,
	onQr,
	onStatus = () => {},
	onNeedVerifyCode,
	signal,
	maxRefreshes = 2,
} = {}) {
	const existing = loadCredentials();
	const localTokens = existing?.token ? [existing.token] : [];
	// 二维码登录固定从官方基座开始；凭证里的 baseUrl 是登录后 Bot 请求的入口，
	// 不能拿来轮询新的二维码（旧的 IDC 主机可能已不可用）。
	let baseUrl = api.baseUrl;
	let lastPng = null;

	try {
	for (let refresh = 0; refresh <= maxRefreshes; refresh++) {
		if (signal?.aborted) throw new Error("login cancelled");
		// 取二维码固定打官方基座；redirect 只用于状态轮询
		const qr = await api.getQrCode(localTokens, api.baseUrl);
		if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error("server did not return a QR code");

		const rendered = renderQr(qr.qrcode_img_content);
		if (lastPng && lastPng !== rendered.pngPath) {
			try {
				fs.rmSync(lastPng, { force: true });
			} catch {
				// ignore
			}
		}
		lastPng = rendered.pngPath;
		log?.info(`等待扫码（第 ${refresh + 1} 次）`);
		onQr?.({ ...rendered, url: qr.qrcode_img_content });
		onStatus("等待扫码…");

		let verifyCode;
		let expired = false;
		let pollErrors = 0;
		while (!expired) {
			if (signal?.aborted) throw new Error("login cancelled");
			let status;
			try {
				status = await api.getQrStatus(qr.qrcode, verifyCode, baseUrl);
			} catch (err) {
				pollErrors++;
				log?.warn(`轮询二维码状态失败 ${pollErrors}/5：${err?.message ?? err}`);
				if (pollErrors >= 5) throw new Error("could not fetch the QR status 5 times in a row; check the network and retry");
				await sleep(1500);
				continue;
			}
			pollErrors = 0;

			switch (status?.status) {
				case "wait":
					break;
				case "scaned":
					onStatus("已扫码，请在手机上确认");
					break;
				case "scaned_but_redirect":
					if (status.redirect_host) {
						baseUrl = `https://${status.redirect_host}`.replace(/\/+$/, "");
						log?.info(`切换到 IDC：${baseUrl}`);
					}
					break;
				case "need_verifycode": {
					onStatus("需要输入手机上的配对码");
					if (!onNeedVerifyCode) throw new Error("a pairing code is required but this environment cannot prompt for it");
					const code = await onNeedVerifyCode();
					if (!code) throw new Error("no pairing code entered; login cancelled");
					verifyCode = String(code).trim();
					break;
				}
				case "verify_code_blocked":
					throw new Error("too many wrong pairing codes; the QR code expired");
				case "expired":
					expired = true;
					log?.info("二维码已过期，重新获取");
					break;
				case "binded_redirect": {
					if (existing?.token) {
						log?.info("扫码的 Bot 已绑定本机，复用现有凭证");
						return existing;
					}
					throw new Error("this bot is bound to another client and no local credentials are available");
				}
				case "confirmed": {
					if (!status.bot_token) throw new Error("login succeeded but no bot_token was returned");
					const credentials = {
						token: status.bot_token,
						botId: status.ilink_bot_id ?? "",
						userId: status.ilink_user_id ?? "",
						baseUrl: safeBaseUrl(status.baseurl) || api.baseUrl,
					};
					saveCredentials(credentials);
					if (!credentials.userId) {
						log?.warn("登录成功但服务端没有返回 ilink_user_id：默认白名单将拒绝所有消息");
					}
					log?.info(`登录成功：bot=${credentials.botId || "?"} user=${credentials.userId ? `${credentials.userId.slice(0, 6)}…` : "?"}`);
					onStatus("登录成功");
					return loadCredentials() ?? credentials;
				}
				default:
					log?.warn(`未知二维码状态：${status?.status ?? "空"}`);
			}
			await sleep(800);
		}
	}
	} finally {
		if (lastPng) {
			try {
				fs.rmSync(lastPng, { force: true });
			} catch {
				// ignore
			}
		}
	}
	throw new Error("the QR code expired repeatedly; login did not finish");
}
