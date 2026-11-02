import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
	describeService,
	isServiceAlive,
	readServiceState,
	removeServiceState,
	serviceStatePath,
	writeServiceState,
} from "../src/service.js";

test("service state：写入/读取/心跳判定/清理", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-svc-"));
	try {
		const file = path.join(dir, "service.json");
		const now = Date.now();
		writeServiceState(file, {
			pid: process.pid,
			startedAt: new Date(now - 1000).toISOString(),
			heartbeatAt: new Date(now).toISOString(),
			sessionId: "pi-weixin-connect-service",
		});
		const state = readServiceState(file);
		assert.equal(state.pid, process.pid);
		assert.equal(isServiceAlive(state), true);
		assert.match(describeService(state), /在线/);

		// 心跳过期
		assert.equal(isServiceAlive(state, { now: now + 50_000 }), false);
		assert.match(describeService(state, { now: now + 50_000 }), /心跳停了/);

		// 别的 pid 不能删
		removeServiceState(file, process.pid + 1);
		assert.ok(fs.existsSync(file));
		removeServiceState(file, process.pid);
		assert.equal(fs.existsSync(file), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("service state：state 路径固定在 agent 目录", () => {
	assert.equal(serviceStatePath("/tmp/agent"), "/tmp/agent/pi-weixin-connect.service.json");
});

test("service state：损坏文件按未运行处理", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piwx-svc2-"));
	try {
		const file = path.join(dir, "service.json");
		fs.writeFileSync(file, "{not json");
		assert.equal(readServiceState(file), null);
		assert.equal(isServiceAlive(null), false);
		assert.equal(describeService(null), "未运行");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
