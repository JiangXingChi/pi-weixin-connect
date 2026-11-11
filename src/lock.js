/**
 * 单实例锁：同一个 Bot 只能有一个进程长轮询，否则消息会被随机分走。
 * 与 pi-qq-connect 同一套实现（硬链接原子抢锁）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function isProcessAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code === "EPERM";
	}
}

export function readLock(file) {
	try {
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		if (data && Number.isInteger(data.pid)) return data;
		return null;
	} catch {
		return null;
	}
}

export function acquireLock(file, { force = false, pid = process.pid } = {}) {
	const holder = readLock(file);
	if (holder && holder.pid !== pid && isProcessAlive(holder.pid) && !force) {
		return { ok: false, holder };
	}
	const payload = JSON.stringify({ pid, host: os.hostname(), at: new Date().toISOString() });
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		fs.writeFileSync(tmp, payload, { mode: 0o600 });
		try {
			fs.linkSync(tmp, file);
			return { ok: true, takenOver: false };
		} catch (err) {
			if (err?.code !== "EEXIST") return { ok: false, error: "could not write the lock file" };
			const current = readLock(file);
			if (current && current.pid !== pid && isProcessAlive(current.pid) && !force) {
				return { ok: false, holder: current };
			}
			fs.renameSync(tmp, file);
			return { ok: true, takenOver: Boolean(holder && holder.pid !== pid && force) };
		}
	} catch (err) {
		return { ok: false, error: err?.message ?? "could not write the lock file" };
	} finally {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// tmp 已被 rename 或本就不存在
		}
	}
}

export function releaseLock(file, pid = process.pid) {
	const holder = readLock(file);
	if (holder && holder.pid !== pid) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// ignore
	}
}
