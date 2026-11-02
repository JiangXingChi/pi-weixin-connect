/**
 * 微信侧文本处理：消息归一化、纯文本化、4000 分片、脱敏。
 */

const MAX_CONTENT_CHARS = 4000;
const INDICATOR_RESERVE = 10;

function safeName(name, fallback = "file.bin") {
	const text = String(name ?? "").replace(/[\r\n\t]+/g, " ").trim();
	return text ? text.slice(0, 120) : fallback;
}

export function maskId(id) {
	const s = String(id ?? "");
	if (s.length <= 12) return s;
	return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** 消息项 → 可读文本 + 附件引用。 */
export function normalizeMessage(raw) {
	if (!raw || typeof raw !== "object") return null;
	if (Number(raw.message_type) !== 1) return null; // 1=用户，2=Bot
	if (Number(raw.message_state) === 1) return null; // 1=生成中，只处理完整消息
	const items = Array.isArray(raw.item_list) ? raw.item_list : [];
	const texts = [];
	const notes = [];
	const images = [];
	const files = [];

	for (const item of items) {
		const type = Number(item?.type);
		if (type === 1) {
			const text = item?.text_item?.text;
			if (typeof text === "string" && text) texts.push(text);
		} else if (type === 2) {
			images.push({
				media: item?.image_item?.media,
				aeskey: item?.image_item?.aeskey,
				midSize: Number(item?.image_item?.mid_size) || 0,
			});
		} else if (type === 3) {
			const transcript = item?.voice_item?.text;
			notes.push(transcript ? `[语音转写] ${transcript}` : "[语音]");
		} else if (type === 4) {
			files.push({
				media: item?.file_item?.media,
				name: safeName(item?.file_item?.file_name),
				len: Number(item?.file_item?.len) || 0,
			});
		} else if (type === 5) {
			notes.push("[视频]");
		}
	}

	const text = [...texts, ...notes].filter(Boolean).join("\n").trim();
	if (!text && images.length === 0 && files.length === 0) return null;
	if (raw.group_id) return null; // 官方只支持单聊，群里的事件一律忽略

	return {
		messageId: String(raw.message_id ?? ""),
		seq: Number(raw.seq) || 0,
		from: String(raw.from_user_id ?? ""),
		to: String(raw.to_user_id ?? ""),
		contextToken: typeof raw.context_token === "string" ? raw.context_token : "",
		at: Number(raw.create_time_ms) || Date.now(),
		text,
		images,
		files,
		kind: "private",
		raw,
	};
}

/** 是否允许该用户（空 allowUsers = 只允许登录者本人）。 */
export function isAllowed(item, cfg, ownerId) {
	if (!item) return false;
	if (item.kind === "private" && cfg.allowUsers.length === 0) {
		// 不知道登录者是谁时不能放行，否则等于 allowAll
		return Boolean(ownerId) && item.from === ownerId;
	}
	return cfg.allowUsers.includes(item.from);
}

/** 拼成 Pi 的用户消息：信封头 + 正文 + 附件说明。 */
export function buildPrompt(item, cfg, extraNotes = []) {
	const lines = [];
	lines.push(`[微信单聊 · 用户 ${maskId(item.from)}]`);
	const body = [item.text, ...extraNotes].filter(Boolean).join("\n");
	if (body) lines.push(body);
	if (cfg.files?.enabled) lines.push("（需要把本地文件发给对方时，在回复末尾单独写一行 [[file:/绝对路径]]，最多 3 个。）");
	return { text: lines.join("\n") };
}

function fenceState(text) {
	let open = false;
	let lang = "";
	for (const line of text.split("\n")) {
		const match = line.match(/^\s*```(\w*)/);
		if (!match) continue;
		if (!open) {
			open = true;
			lang = match[1] || "";
		} else {
			open = false;
			lang = "";
		}
	}
	return { open, lang };
}

function splitFenced(text, limit) {
	const chunks = [];
	let rest = text;
	let carryLang = null;
	let guard = 0;
	while (rest.length > 0 && guard++ < 500) {
		const prefix = carryLang !== null ? `\`\`\`${carryLang}\n` : "";
		if (prefix.length + rest.length <= limit) {
			let chunk = prefix + rest;
			if (carryLang !== null && fenceState(chunk).open) chunk += "\n```";
			chunks.push(chunk);
			break;
		}
		const headroom = Math.max(1, limit - prefix.length - 5);
		let cut = rest.lastIndexOf("\n", headroom);
		if (cut < Math.floor(headroom * 0.5)) cut = rest.lastIndexOf(" ", headroom);
		if (cut <= 0) cut = headroom;
		let chunk = prefix + rest.slice(0, cut);
		const state = fenceState(chunk);
		if (state.open) {
			chunk += "\n```";
			carryLang = state.lang;
		} else {
			carryLang = null;
		}
		chunks.push(chunk);
		rest = rest.slice(cut).replace(/^\n/, "");
	}
	return chunks;
}

/** 分片 + (i/n)；超过 maxChunks 只发前几段并带提示。 */
export function chunkText(
	text,
	{ chunkChars = MAX_CONTENT_CHARS, maxChunks = 9, overflowHint = "……（内容过长，完整结果见 Pi 终端）" } = {},
) {
	const normalized = String(text ?? "").trim();
	if (!normalized) return [];
	const limit = Math.max(200, Math.min(chunkChars, MAX_CONTENT_CHARS));
	// 只有确实要拆段时才为 "(i/n)" 预留空间；单段保持 4000 的完整容量
	const reserve = normalized.length > limit ? INDICATOR_RESERVE + 2 : 0;
	const raw = splitFenced(normalized, Math.max(100, limit - reserve));

	let chunks = raw.filter((c) => c.trim());
	if (chunks.length > 1) chunks = chunks.map((chunk, i) => `${chunk} (${i + 1}/${chunks.length})`);
	if (chunks.length <= maxChunks) return chunks;

	const kept = chunks.slice(0, maxChunks);
	const last = kept[maxChunks - 1] ?? "";
	const hint = `\n${overflowHint}`;
	const room = Math.max(0, limit - hint.length);
	kept[maxChunks - 1] = (last.length > room ? last.slice(0, room) : last) + hint;
	return kept;
}

/** 微信不渲染 Markdown：去掉标记，保留内容。 */
export function stripMarkdown(input) {
	let text = String(input ?? "");
	text = text.replace(/```[a-zA-Z0-9_+-]*\n?/g, "").replace(/```/g, "");
	text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "$1（$2）");
	text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）");
	text = text.replace(/^#{1,6}\s+/gm, "");
	text = text.replace(/^\s*>\s?/gm, "");
	text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");
	text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
	text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
	text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2");
	text = text.replace(/~~([^~]+)~~/g, "$1");
	text = text.replace(/`([^`\n]+)`/g, "$1");
	text = text.replace(/[ \t]+\n/g, "\n");
	text = text.replace(/\n{3,}/g, "\n\n");
	return text.trim();
}
