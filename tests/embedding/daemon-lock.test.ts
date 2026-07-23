import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireDaemonLock,
	clearDeadDaemonLock,
	type DaemonLock,
	isProcessAlive,
	readDaemonLock,
	releaseDaemonLock,
} from "@/embedding/daemon/lock";

function makeLockPath(): string {
	return join(mkdtempSync(join(tmpdir(), "cortex-lock-")), "model.lock");
}

function makeLock(pid: number): DaemonLock {
	return {
		pid,
		version: "0.1.0",
		modelId: "model@1",
		socketPath: "/tmp/model.sock",
		startedAt: Date.now(),
	};
}

async function exitedProcessPid(): Promise<number> {
	const child = Bun.spawn(["bun", "-e", "process.exit(0)"]);
	await child.exited;
	return child.pid;
}

describe("daemon lock", () => {
	test("first acquire wins, second loses, record round-trips", () => {
		const lockPath = makeLockPath();
		expect(acquireDaemonLock(lockPath, makeLock(process.pid))).toBe(true);
		expect(acquireDaemonLock(lockPath, makeLock(process.pid))).toBe(false);
		expect(readDaemonLock(lockPath)?.pid).toBe(process.pid);
	});

	test("an unreadable lock decodes to null and is never cleared", () => {
		const lockPath = makeLockPath();
		writeFileSync(lockPath, "not json");
		expect(readDaemonLock(lockPath)).toBeNull();
		expect(clearDeadDaemonLock(lockPath, 12345)).toBe(false);
		expect(readFileSync(lockPath, "utf8")).toBe("not json");
	});

	test("clearDeadDaemonLock removes only a dead holder's lock", async () => {
		const lockPath = makeLockPath();
		acquireDaemonLock(lockPath, makeLock(process.pid));
		expect(clearDeadDaemonLock(lockPath, process.pid)).toBe(false);
		expect(readDaemonLock(lockPath)).not.toBeNull();

		const deadPath = makeLockPath();
		const deadPid = await exitedProcessPid();
		acquireDaemonLock(deadPath, makeLock(deadPid));
		expect(clearDeadDaemonLock(deadPath, deadPid)).toBe(true);
		expect(readDaemonLock(deadPath)).toBeNull();
	});

	test("clearDeadDaemonLock refuses when the pid changed since the read", async () => {
		const lockPath = makeLockPath();
		acquireDaemonLock(lockPath, makeLock(await exitedProcessPid()));
		expect(clearDeadDaemonLock(lockPath, 1)).toBe(false);
		expect(readDaemonLock(lockPath)).not.toBeNull();
	});

	test("releaseDaemonLock removes only the caller's own lock", () => {
		const lockPath = makeLockPath();
		acquireDaemonLock(lockPath, makeLock(process.pid));
		releaseDaemonLock(lockPath, process.pid + 1);
		expect(readDaemonLock(lockPath)).not.toBeNull();
		releaseDaemonLock(lockPath, process.pid);
		expect(readDaemonLock(lockPath)).toBeNull();
	});

	test("isProcessAlive distinguishes live from exited processes", async () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(await exitedProcessPid())).toBe(false);
	});
});
