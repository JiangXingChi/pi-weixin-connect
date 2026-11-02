import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	aesEcbPaddedSize,
	decryptAesEcb,
	encryptAesEcb,
	inspectFile,
	parseAesKey,
	parseFileMarkers,
	sniffImageMime,
	uploadFile,
} from "../src/media.js";
import { WeixinApi } from "../src/api.js";
import { startMock } from "./mock-ilink.mjs";

test("AES-128-ECB：加解密往返、PKCS7 尺寸、三种密钥编码", () => {
	const key = crypto.randomBytes(16);
	const plain = Buffer.from("hello 微信 media");
	const cipher = encryptAesEcb(plain, key);
	assert.equal(cipher.length, aesEcbPaddedSize(plain.length));
	assert.deepEqual(decryptAesEcb(cipher, key), plain);

	// 格式 A：base64(原始 16 字节)
	assert.deepEqual(parseAesKey(key.toString("base64")), key);
	// 格式 B：base64(hex 字符串)
	assert.deepEqual(parseAesKey(Buffer.from(key.toString("hex"), "utf8").toString("base64")), key);
	// 格式 C：直接 hex
	assert.deepEqual(parseAesKey(key.toString("hex")), key);
	assert.equal(parseAesKey("not-a-key"), null);
});

test("sniffImageMime：png / jpeg / gif / webp", () => {
	assert.equal(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0])), "image/png");
	assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");
	assert.equal(sniffImageMime(Buffer.from("GIF89a......")), "image/gif");
	assert.equal(sniffImageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
});

test("文件标记：最多 3 个、敏感路径拒绝、大小上限", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-files-"));
	try {
		for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}`);
		const text = `结果见附件\n[[file:${dir}/f1.txt]]\n[[file:${dir}/f2.txt]]\n[[file:${dir}/f3.txt]]\n[[file:${dir}/f4.txt]]`;
		const parsed = parseFileMarkers(text, { maxCount: 3, maxBytes: 1024 });
		assert.equal(parsed.files.length, 3);
		assert.equal(parsed.skipped.length, 1);
		assert.equal(parsed.text, "结果见附件");

		const denied = parseFileMarkers(`[[file:${os.homedir()}/.ssh/id_rsa]]`, { maxCount: 3 });
		assert.equal(denied.files.length, 0);
		assert.match(denied.skipped[0].reason, /敏感路径/);

		const tooBig = path.join(dir, "big.bin");
		fs.writeFileSync(tooBig, Buffer.alloc(2048));
		const over = parseFileMarkers(`[[file:${tooBig}]]`, { maxCount: 3, maxBytes: 1024 });
		assert.equal(over.files.length, 0);
		assert.match(over.skipped[0].reason, /超过上限/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("uploadFile：getuploadurl → AES 密文上传 → media 引用", async () => {
	const mock = await startMock();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-up-"));
	try {
		const file = path.join(dir, "note.txt");
		const content = Buffer.from("hello upload");
		fs.writeFileSync(file, content);
		const api = new WeixinApi({ baseUrl: mock.baseUrl });
		const uploaded = await uploadFile(api, "token-abc", {
			to: "user-1",
			filePath: file,
			mediaType: 3,
			cdnBaseUrl: `${mock.baseUrl}/cdn`,
		});

		assert.equal(uploaded.name, "note.txt");
		assert.equal(uploaded.rawSize, content.length);
		assert.equal(uploaded.cipherSize, aesEcbPaddedSize(content.length));
		assert.equal(uploaded.media.encrypt_query_param, "download-param-1");
		assert.equal(uploaded.media.encrypt_type, 1);

		const req = mock.uploadRequests[0];
		assert.equal(req.media_type, 3);
		assert.equal(req.to_user_id, "user-1");
		assert.equal(req.rawsize, content.length);
		assert.equal(req.filesize, aesEcbPaddedSize(content.length));
		assert.equal(req.no_need_thumb, true);
		assert.equal(req.rawfilemd5, crypto.createHash("md5").update(content).digest("hex"));
		assert.match(req.aeskey, /^[0-9a-f]{32}$/);

		assert.equal(mock.uploads.length, 1);
		assert.equal(mock.uploads[0].size, aesEcbPaddedSize(content.length));
	} finally {
		await mock.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inspectFile：镜像/视频/普通文件与上限", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-ins-"));
	try {
		const img = path.join(dir, "a.png");
		fs.writeFileSync(img, Buffer.alloc(64));
		assert.equal(inspectFile(img).kind, "image");
		assert.equal(inspectFile(img).mediaType, 1);

		const video = path.join(dir, "a.mp4");
		fs.writeFileSync(video, Buffer.alloc(64));
		assert.equal(inspectFile(video).kind, "video");

		const txt = path.join(dir, "a.txt");
		fs.writeFileSync(txt, Buffer.alloc(64));
		assert.equal(inspectFile(txt).kind, "file");
		assert.equal(inspectFile(path.join(dir, "missing")).reason, "文件不存在");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
