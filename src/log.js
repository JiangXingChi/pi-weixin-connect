/**
 * 极简文件日志：按级别过滤、超过上限自动轮转一份 .1。
 * 只写文件，不往 stdout 写（RPC 模式下 stdout 是协议通道）。
 */

import fs from "node:fs";
import path from "node:path";

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
	constructor({ file, level = "info", maxBytes = 2 * 1024 * 1024 } = {}) {
		this.file = file;
		this.level = ORDER[level] ? level : "info";
		this.maxBytes = maxBytes;
		this.buffer = [];
	}

	#write(level, message) {
		if (ORDER[level] < ORDER[this.level]) return;
		const line = `${new Date().toISOString()} [${level}] ${message}`;
		this.buffer.push(line);
		if (this.buffer.length > 200) this.buffer.shift();
		if (!this.file) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			this.#rotateIfNeeded();
			fs.appendFileSync(this.file, line + "\n", { mode: 0o600 });
		} catch {
			// 日志写不进去不该影响机器人
		}
	}

	#rotateIfNeeded() {
		try {
			const stat = fs.statSync(this.file);
			if (stat.size < this.maxBytes) return;
			fs.renameSync(this.file, this.file + ".1");
		} catch {
			// 文件不存在等情况忽略
		}
	}

	debug(msg) {
		this.#write("debug", msg);
	}
	info(msg) {
		this.#write("info", msg);
	}
	warn(msg) {
		this.#write("warn", msg);
	}
	error(msg) {
		this.#write("error", msg);
	}

	tail(n = 20) {
		if (!this.file) return this.buffer.slice(-n);
		try {
			const lines = fs.readFileSync(this.file, "utf8").trimEnd().split("\n");
			return lines.slice(-n);
		} catch {
			return this.buffer.slice(-n);
		}
	}
}
