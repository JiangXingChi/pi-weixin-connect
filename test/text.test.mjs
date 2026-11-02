import assert from "node:assert/strict";
import test from "node:test";

import { chunkText, isAllowed, normalizeMessage, stripMarkdown } from "../src/text.js";

test("normalizeMessage：收集文本与附件占位，忽略 Bot 与群聊", () => {
	const item = normalizeMessage({
		message_id: 42,
		message_type: 1,
		from_user_id: "u1",
		context_token: "ctx",
		create_time_ms: 1000,
		item_list: [
			{ type: 1, text_item: { text: "你好" } },
			{ type: 2, image_item: { url: "https://x" } },
			{ type: 3, voice_item: { text: "语音内容" } },
		],
	});
	assert.equal(item.text, "你好\n[语音转写] 语音内容");
	assert.equal(item.images.length, 1);
	assert.equal(item.contextToken, "ctx");
	assert.equal(item.messageId, "42");

	assert.equal(normalizeMessage({ message_type: 2, item_list: [{ type: 1, text_item: { text: "bot" } }] }), null);
	assert.equal(
		normalizeMessage({ message_type: 1, group_id: "g1", item_list: [{ type: 1, text_item: { text: "hi" } }] }),
		null,
	);
});

test("isAllowed：空白名单只允许登录者本人，非空按列表", () => {
	const cfg = { allowUsers: [] };
	assert.equal(isAllowed({ kind: "private", from: "owner" }, cfg, "owner"), true);
	assert.equal(isAllowed({ kind: "private", from: "other" }, cfg, "owner"), false);
	assert.equal(isAllowed({ kind: "private", from: "other" }, { allowUsers: ["other"] }, "owner"), true);
});

test("chunkText：不超过 4000，超出预算截断并带提示", () => {
	const text = Array.from({ length: 12 }, (_, i) => `第${i + 1}段` + "x".repeat(3500)).join("\n\n");
	const chunks = chunkText(text, { chunkChars: 4000, maxChunks: 9 });
	assert.equal(chunks.length, 9);
	for (const chunk of chunks) assert.ok(chunk.length <= 4000, `chunk too long: ${chunk.length}`);
	assert.match(chunks[8], /内容过长/);
});

test("chunkText：多段带 (i/n) 序号，代码围栏闭合", () => {
	const text = "```js\n" + "const a = 1;\n".repeat(500) + "```";
	const chunks = chunkText(text, { chunkChars: 1000, maxChunks: 9 });
	assert.ok(chunks.length > 1);
	for (const chunk of chunks) {
		const fences = (chunk.match(/```/g) ?? []).length;
		assert.equal(fences % 2, 0, `unclosed fence: ${fences}`);
	}
	assert.match(chunks[0], /\(1\/\d+\)$/);
});

test("stripMarkdown：去标记保内容", () => {
	const input = "# 标题\n\n**加粗** 和 `代码`\n\n- 列表\n\n[链接](https://x)";
	const output = stripMarkdown(input);
	assert.doesNotMatch(output, /^#/m);
	assert.doesNotMatch(output, /\*\*/);
	assert.match(output, /标题/);
	assert.match(output, /加粗/);
	assert.match(output, /链接（https:\/\/x）/);
});
