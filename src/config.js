/**
 * 配置加载：~/.pi/agent/pi-weixin-connect.json
 *
 * 与 pi-qq-connect 不同，微信没有 AppID/Secret：凭证来自扫码登录。
 * 因此配置文件可以不存在，全部走默认值。
 *
 * 环境变量：PIWXCONNECT_CONFIG / PIWXCONNECT_DISABLED / PIWXCONNECT_BASE
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(value) {
	if (typeof value !== "string" || !value) return value;
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

export function configPath() {
	return expandHome(process.env.PIWXCONNECT_CONFIG) || path.join(os.homedir(), ".pi/agent", "pi-weixin-connect.json");
}

export function credentialsPath() {
	return expandHome(process.env.PIWXCONNECT_CREDENTIALS) || path.join(os.homedir(), ".pi/agent", ".pi-weixin", "credentials.json");
}

export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	// 空数组 = 只允许扫码登录的那个微信用户；填了则只允许列表内的人
	allowUsers: [],
	replyFormat: "plain", // plain | markdown（微信不渲染 Markdown，默认 plain）
	chunkChars: 4000, // 官方实现的上限
	maxChunks: 9, // 连发 10 条会被微信阻断，留 1 条余量
	sessionWindowHours: 24, // context_token 有效期
	typing: true,
	maxQueue: 20,
	emptyReply: "(pi returned no text this round)",
	dedupeTtlMs: 10 * 60 * 1000,
	lock: true,
	// standalone：微信跑独立后台进程/会话（默认，避免陷进“共享会话”的坑）
	// inline：挂在当前 Pi 进程里（兼容旧行为）
	service: { mode: "standalone", sessionId: "pi-weixin-connect-service" },
	images: { enabled: true, maxCount: 2, maxBytes: 8 * 1024 * 1024 },
	files: { enabled: true, maxCount: 3, maxBytes: 200 * 1024 * 1024, allowDirs: [] },
	log: { file: "~/.pi/agent/pi-weixin-connect.log", level: "info", maxBytes: 2 * 1024 * 1024 },
	endpoints: { base: "https://ilinkai.weixin.qq.com", cdn: "https://novac2c.cdn.weixin.qq.com/c2c" },
});

function mergeSection(base, value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...base };
	return { ...base, ...value };
}

function boolIn(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return !/^(false|0|off|no)$/i.test(value.trim());
	return Boolean(value);
}

function intIn(value, fallback, min, max) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function loadConfig() {
	const file = configPath();
	const exists = fs.existsSync(file);
	const warnings = [];
	let error = null;
	let raw = {};

	if (exists) {
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				error = "config is not a JSON object";
				raw = {};
			}
		} catch (err) {
			error = `could not parse config: ${err?.message ?? err}`;
			raw = {};
		}
	}

	const cfg = mergeSection(DEFAULT_CONFIG, raw);
	cfg.enabled = boolIn(cfg.enabled, DEFAULT_CONFIG.enabled);
	cfg.typing = boolIn(cfg.typing, DEFAULT_CONFIG.typing);
	cfg.lock = boolIn(cfg.lock, DEFAULT_CONFIG.lock);
	cfg.allowUsers = Array.isArray(cfg.allowUsers) ? cfg.allowUsers.map((v) => String(v).trim()).filter(Boolean) : [];
	cfg.replyFormat = cfg.replyFormat === "markdown" ? "markdown" : "plain";
	cfg.chunkChars = intIn(cfg.chunkChars, DEFAULT_CONFIG.chunkChars, 200, 4000);
	cfg.maxChunks = intIn(cfg.maxChunks, DEFAULT_CONFIG.maxChunks, 1, 9);
	cfg.sessionWindowHours = intIn(cfg.sessionWindowHours, DEFAULT_CONFIG.sessionWindowHours, 1, 24);
	cfg.maxQueue = intIn(cfg.maxQueue, DEFAULT_CONFIG.maxQueue, 1, 200);
	cfg.dedupeTtlMs = intIn(cfg.dedupeTtlMs, DEFAULT_CONFIG.dedupeTtlMs, 1000, 86_400_000);
	cfg.service = mergeSection(DEFAULT_CONFIG.service, cfg.service);
	cfg.service.mode = cfg.service.mode === "inline" ? "inline" : "standalone";
	cfg.service.sessionId = String(cfg.service.sessionId || DEFAULT_CONFIG.service.sessionId).replace(/[^\w.-]/g, "-");
	cfg.images = mergeSection(DEFAULT_CONFIG.images, cfg.images);
	cfg.images.enabled = boolIn(cfg.images.enabled, DEFAULT_CONFIG.images.enabled);
	cfg.images.maxCount = intIn(cfg.images.maxCount, DEFAULT_CONFIG.images.maxCount, 0, 10);
	cfg.images.maxBytes = intIn(cfg.images.maxBytes, DEFAULT_CONFIG.images.maxBytes, 1024, 30 * 1024 * 1024);
	cfg.files = mergeSection(DEFAULT_CONFIG.files, cfg.files);
	cfg.files.enabled = boolIn(cfg.files.enabled, DEFAULT_CONFIG.files.enabled);
	cfg.files.maxCount = intIn(cfg.files.maxCount, DEFAULT_CONFIG.files.maxCount, 0, 9);
	cfg.files.maxBytes = intIn(cfg.files.maxBytes, DEFAULT_CONFIG.files.maxBytes, 1024, 200 * 1024 * 1024);
	cfg.files.allowDirs = Array.isArray(cfg.files.allowDirs) ? cfg.files.allowDirs.map(expandHome) : [];
	cfg.log = mergeSection(DEFAULT_CONFIG.log, cfg.log);
	cfg.log.file = expandHome(cfg.log.file || DEFAULT_CONFIG.log.file);
	cfg.log.maxBytes = intIn(cfg.log.maxBytes, DEFAULT_CONFIG.log.maxBytes, 64 * 1024, 100 * 1024 * 1024);
	cfg.endpoints = mergeSection(DEFAULT_CONFIG.endpoints, cfg.endpoints);

	if (process.env.PIWXCONNECT_DISABLED === "1") cfg.enabled = false;
	if (process.env.PIWXCONNECT_BASE) cfg.endpoints.base = process.env.PIWXCONNECT_BASE;

	if (!exists) warnings.push(`没有配置文件，使用默认值：${file}`);

	return { config: cfg, path: file, exists, warnings, error };
}
