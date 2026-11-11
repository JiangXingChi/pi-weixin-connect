/**
 * 微信媒体：AES-128-ECB 加解密、CDN 上传/下载、文件标记解析。
 *
 * 协议要点（腾讯 openclaw-weixin docs/protocol_zh_CN.md）：
 *  - 所有 CDN 媒体用 AES-128-ECB + PKCS#7；
 *  - aes_key 有三种编码：base64(16 字节)、base64(hex 字符串)、直接 hex；
 *  - 上传：getuploadurl → POST 密文 → 读响应头 x-encrypted-param；
 *  - 发送：image_item/file_item 里放 media.encrypt_query_param + base64(hex aeskey)。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CDN_MAX_BYTES = 200 * 1024 * 1024;
export const OUT_IMAGE_MAX = 20 * 1024 * 1024;
export const OUT_VIDEO_MAX = 30 * 1024 * 1024;

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv"]);

const DENY_PREFIXES = ["/etc", "/proc", "/sys", "/dev", "/boot"];
const DENY_HOME = [
	".ssh",
	".gnupg",
	".pi/agent",
	".config",
	".local/share/keyrings",
	".git-credentials",
	".netrc",
	".npmrc",
	".aws",
	".docker",
	".kube",
];

export function aesEcbPaddedSize(size) {
	return Math.ceil((size + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext, key) {
	const cipher = createCipheriv("aes-128-ecb", key, null);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext, key) {
	const decipher = createDecipheriv("aes-128-ecb", key, null);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 三种密钥编码 → Buffer；失败返回 null。 */
export function parseAesKey(value) {
	if (!value) return null;
	const raw = String(value).trim();
	try {
		if (/^[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw, "hex");
		const decoded = Buffer.from(raw, "base64");
		if (decoded.length === 16) return decoded;
		const text = decoded.toString("utf8");
		if (/^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
	} catch {
		// ignore
	}
	return null;
}

export function mimeForName(name) {
	const ext = path.extname(String(name ?? "")).slice(1).toLowerCase();
	const table = {
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		webp: "image/webp",
		bmp: "image/bmp",
		pdf: "application/pdf",
		txt: "text/plain",
		md: "text/markdown",
		json: "application/json",
		csv: "text/csv",
		zip: "application/zip",
		mp4: "video/mp4",
		mp3: "audio/mpeg",
		wav: "audio/wav",
	};
	return table[ext] ?? "application/octet-stream";
}

export function mediaKindForFile(filePath) {
	const ext = path.extname(String(filePath ?? "")).slice(1).toLowerCase();
	if (IMAGE_EXT.has(ext)) return { mediaType: 1, kind: "image", maxBytes: OUT_IMAGE_MAX };
	if (VIDEO_EXT.has(ext)) return { mediaType: 2, kind: "video", maxBytes: OUT_VIDEO_MAX };
	return { mediaType: 3, kind: "file", maxBytes: CDN_MAX_BYTES };
}

function realPath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.resolve(filePath);
	}
}

function isDenied(filePath, allowDirs) {
	// 先解掉符号链接，再判断前缀；否则允许目录里的软链可以指向 ~/.ssh
	const resolved = realPath(filePath);
	if (DENY_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(prefix + "/"))) return true;
	const home = path.resolve(os.homedir());
	for (const rel of DENY_HOME) {
		const root = path.join(home, rel);
		if (resolved === root || resolved.startsWith(root + path.sep)) return true;
	}
	if (allowDirs?.length) {
		return !allowDirs.some((dir) => {
			const root = realPath(dir);
			return resolved === root || resolved.startsWith(root + path.sep);
		});
	}
	// 默认白名单：家目录、当前工作目录、临时目录（与 PLAN §6.8 一致）
	const defaults = [home, process.cwd(), os.tmpdir()].map(realPath);
	return !defaults.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** 校验出站文件；返回 {ok, size, kind, reason}。 */
export function inspectFile(filePath, { maxBytes = CDN_MAX_BYTES, allowDirs = [] } = {}) {
	const resolved = realPath(String(filePath ?? ""));
	if (isDenied(resolved, allowDirs)) return { ok: false, reason: "path is not allowed", path: resolved };
	let stat;
	try {
		stat = fs.statSync(resolved);
	} catch {
		return { ok: false, reason: "file not found", path: resolved };
	}
	if (!stat.isFile()) return { ok: false, reason: "not a regular file", path: resolved };
	const { mediaType, kind, maxBytes: limit } = mediaKindForFile(resolved);
	const cap = Math.min(maxBytes, limit);
	if (stat.size > cap) return { ok: false, reason: `exceeds the ${Math.round(cap / 1048576)}MB limit`, path: resolved };
	return { ok: true, size: stat.size, kind, mediaType, path: resolved, name: path.basename(resolved) };
}

/**
 * 解析回复里的 [[file:/abs/path]] 标记。
 * 返回 {text, files:[{path, marker}], skipped:[{path, reason}]}。
 */
export function parseFileMarkers(text, { maxCount = 3, maxBytes = CDN_MAX_BYTES, allowDirs = [], disabled = false } = {}) {
	const input = String(text ?? "");
	const files = [];
	const skipped = [];
	let disabledCount = 0;
	const kept = input.replace(/\[\[file:([^\]]+)\]\]/gi, (marker, rawPath) => {
		const filePath = rawPath.trim();
		if (disabled) {
			disabledCount++;
			return "";
		}
		if (files.length + skipped.length >= maxCount + 5) {
			skipped.push({ path: filePath, reason: "too many file markers" });
			return "";
		}
		const check = inspectFile(filePath, { maxBytes, allowDirs });
		if (!check.ok) {
			skipped.push({ path: filePath, reason: check.reason });
			return "";
		}
		if (files.length >= maxCount) {
			skipped.push({ path: filePath, reason: `at most ${maxCount} files` });
			return "";
		}
		files.push({ path: check.path, name: check.name, kind: check.kind, mediaType: check.mediaType, size: check.size });
		return "";
	});
	if (disabled && disabledCount > 0) {
		skipped.push({ path: "", reason: "file sending is disabled", count: disabledCount });
	}
	return { text: kept.trim(), files, skipped };
}

function uploadUrl(uploadFullUrl, uploadParam, filekey, cdnBaseUrl) {
	if (uploadFullUrl?.trim()) return uploadFullUrl.trim();
	if (uploadParam) {
		return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
	}
	throw new Error("getuploadurl returned no upload url");
}

/**
 * 上传文件到 CDN。返回 media 引用与尺寸。
 */
export async function uploadFile(api, token, { to, filePath, mediaType, cdnBaseUrl, log }) {
	const plaintext = await fs.promises.readFile(filePath);
	const rawsize = plaintext.length;
	const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
	const filesize = aesEcbPaddedSize(rawsize);
	const filekey = randomBytes(16).toString("hex");
	const aeskey = randomBytes(16);
	const ciphertext = encryptAesEcb(plaintext, aeskey);

	const info = await api.getUploadUrl(token, {
		filekey,
		media_type: mediaType,
		to_user_id: to,
		rawsize,
		rawfilemd5,
		filesize,
		no_need_thumb: true,
		aeskey: aeskey.toString("hex"),
	});
	const url = uploadUrl(info?.upload_full_url, info?.upload_param, filekey, cdnBaseUrl);

	let lastError;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: new Uint8Array(ciphertext),
				signal: AbortSignal.timeout(120_000),
			});
			if (res.status >= 400 && res.status < 500) {
				const msg = res.headers.get("x-error-message") ?? `HTTP ${res.status}`;
				throw new Error(`CDN client error ${res.status}: ${msg}`);
			}
			if (res.status !== 200) {
				throw new Error(`CDN server error HTTP ${res.status}`);
			}
			const downloadParam = res.headers.get("x-encrypted-param");
			if (!downloadParam) throw new Error("CDN response is missing x-encrypted-param");
			return {
				media: {
					encrypt_query_param: downloadParam,
					aes_key: Buffer.from(aeskey.toString("hex"), "utf8").toString("base64"),
					encrypt_type: 1,
				},
				rawSize: rawsize,
				cipherSize: filesize,
				name: path.basename(filePath),
			};
		} catch (err) {
			lastError = err;
			if (/^CDN client error /.test(String(err?.message))) break;
			log?.warn(`CDN 上传失败 ${attempt}/3：${err?.message ?? err}`);
			await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
		}
	}
	throw lastError ?? new Error("CDN upload failed");
}

/** 下载 CDN 媒体并解密；返回 Buffer。 */
export async function downloadMedia({ media, itemAeskey, cdnBaseUrl, maxBytes = CDN_MAX_BYTES, requireKey = false }) {
	if (!media?.full_url && !media?.encrypt_query_param) throw new Error("media is missing download parameters");
	const url =
		media.full_url?.trim() ||
		`${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
	if (!res.ok) throw new Error(`media download HTTP ${res.status}`);
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error("media exceeds the size limit");
	const ciphertext = Buffer.from(await res.arrayBuffer());
	if (ciphertext.length > maxBytes) throw new Error("media exceeds the size limit");

	const key = parseAesKey(itemAeskey) ?? parseAesKey(media.aes_key);
	if (!key) {
		if (requireKey) throw new Error("media is missing its decryption key");
		return ciphertext; // 明文图片
	}
	return decryptAesEcb(ciphertext, key);
}

/** 从文件头判断图片 MIME（微信入站图片常见 png/jpg/gif/webp）。 */
export function sniffImageMime(buf) {
	if (!buf || buf.length < 12) return "image/jpeg";
	if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
	if (buf.slice(0, 3).toString("ascii") === "GIF") return "image/gif";
	if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (buf.slice(0, 2).toString("ascii") === "BM") return "image/bmp";
	return "image/jpeg";
}
