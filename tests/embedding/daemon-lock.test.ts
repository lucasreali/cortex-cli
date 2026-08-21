import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	acquireDaemonLock,
	clearAbandonedDaemonLock,
	type DaemonLock,
	daemonLockIsAbandoned,
	isProcessAlive,
	REUSED_PID_LOCK_AGE_MS,
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

const listening = () => Promise.resolve(true);
const silent = () => Promise.resolve(false);

// The probe is skipped entirely on the paths that decide by pid or age alone.
const refuseToProbe = () => Promise.reject(new Error("probed anyway"));

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
		const holder = makeLock(12345);
		writeFileSync(lockPath, "not json");
		expect(readDaemonLock(lockPath)).toBeNull();
		expect(clearAbandonedDaemonLock(lockPath, holder)).toBe(false);
		expect(readFileSync(lockPath, "utf8")).toBe("not json");
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

	// H17: `process.kill(pid, 0)` answers "some process has this pid", not "our
	// daemon has it", so a reused pid used to disable the shared daemon for
	// every process on the machine until a human deleted the file.
	test("a live pid with nothing listening is abandoned once the lock is old", async () => {
		const holder = {
			...makeLock(process.pid),
			startedAt: Date.now() - REUSED_PID_LOCK_AGE_MS - 1,
		};
		expect(await daemonLockIsAbandoned(holder, silent)).toBe(true);
	});

	test("a young lock is respected without even probing the socket", async () => {
		const holder = { ...makeLock(process.pid), startedAt: Date.now() };
		expect(await daemonLockIsAbandoned(holder, refuseToProbe)).toBe(false);
	});

	test("an old lock whose socket still answers keeps the daemon role", async () => {
		const holder = {
			...makeLock(process.pid),
			startedAt: Date.now() - REUSED_PID_LOCK_AGE_MS - 1,
		};
		expect(await daemonLockIsAbandoned(holder, listening)).toBe(false);
	});

	test("a dead pid is abandoned without probing the socket", async () => {
		const holder = {
			...makeLock(await exitedProcessPid()),
			startedAt: Date.now(),
		};
		expect(await daemonLockIsAbandoned(holder, refuseToProbe)).toBe(true);
	});

	// The probe that judged the holder abandoned took time; a daemon that won
	// the lock meanwhile must keep it.
	test("clearAbandonedDaemonLock spares a lock replaced during the probe", () => {
		const lockPath = makeLockPath();
		const abandoned = makeLock(process.pid);
		acquireDaemonLock(lockPath, abandoned);
		releaseDaemonLock(lockPath, process.pid);
		acquireDaemonLock(lockPath, { ...abandoned, startedAt: Date.now() + 1 });

		expect(clearAbandonedDaemonLock(lockPath, abandoned)).toBe(false);
		expect(readDaemonLock(lockPath)).not.toBeNull();
		expect(clearAbandonedDaemonLock(lockPath, { ...abandoned, pid: 1 })).toBe(
			false,
		);
		expect(readDaemonLock(lockPath)).not.toBeNull();
	});

	test("clearAbandonedDaemonLock removes the lock it was handed", () => {
		const lockPath = makeLockPath();
		const holder = makeLock(process.pid);
		acquireDaemonLock(lockPath, holder);
		expect(clearAbandonedDaemonLock(lockPath, holder)).toBe(true);
		expect(readDaemonLock(lockPath)).toBeNull();
		expect(clearAbandonedDaemonLock(lockPath, holder)).toBe(false);
	});

	// A lock written before startedAt existed must stay reclaimable; reading it
	// as unreadable would make it immortal instead.
	test("a lock without startedAt reads as the epoch, not as garbage", () => {
		const lockPath = makeLockPath();
		const { startedAt: _ignored, ...legacy } = makeLock(process.pid);
		writeFileSync(lockPath, JSON.stringify(legacy));
		expect(readDaemonLock(lockPath)?.startedAt).toBe(0);
	});

	test("a lock that cannot be unlinked reports failure instead of throwing", async () => {
		const lockPath = makeLockPath();
		const directory = dirname(lockPath);
		const holder = makeLock(await exitedProcessPid());
		acquireDaemonLock(lockPath, holder);
		chmodSync(directory, 0o500);
		try {
			expect(clearAbandonedDaemonLock(lockPath, holder)).toBe(false);
		} finally {
			chmodSync(directory, 0o700);
		}
	});
});
