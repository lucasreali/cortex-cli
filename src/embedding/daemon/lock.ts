import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errnoCode } from "@/support/errors";
import { parseJsonOrNull } from "@/support/json";

export interface DaemonLock {
	pid: number;
	version: string;
	modelId: string;
	socketPath: string;
	startedAt: number;
}

// A pid outlives the process that owned it: after a kill -9, an OOM kill or a
// reboot with a surviving lock file, some unrelated process eventually inherits
// the number and `process.kill(pid, 0)` starts lying. A lock this old whose
// socket accepts nothing is that lie — a daemon listens before it ever writes
// its lock, so a live one always answers.
export const REUSED_PID_LOCK_AGE_MS = 5 * 60 * 1000;

// "wx" keeps acquisition atomic and exclusive: whoever creates the file owns
// the daemon role. Readers never clear a lock they cannot decode (see
// clearAbandonedDaemonLock), so the brief create-then-write window in which
// the file exists empty can be misread but never produces two daemons.
export function acquireDaemonLock(lockPath: string, lock: DaemonLock): boolean {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if (errnoCode(error) === "EEXIST") return false;
		throw error;
	}
}

export function readDaemonLock(lockPath: string): DaemonLock | null {
	try {
		return decodeLock(readFileSync(lockPath, "utf8"));
	} catch {
		return null;
	}
}

// The holder was judged abandoned by a probe that took time, so the file is
// re-read and matched on both pid and start time: a racing daemon's fresh lock
// has to survive this.
export function clearAbandonedDaemonLock(
	lockPath: string,
	abandoned: DaemonLock,
): boolean {
	const current = readDaemonLock(lockPath);
	if (!current) return false;
	if (current.pid !== abandoned.pid) return false;
	if (current.startedAt !== abandoned.startedAt) return false;
	return removeLockFile(lockPath);
}

export function releaseDaemonLock(lockPath: string, ownPid: number): void {
	const current = readDaemonLock(lockPath);
	if (current?.pid !== ownPid) return;
	removeLockFile(lockPath);
}

// Ownership no cortex process can verify by pid alone is decided here, and it
// is the only thing standing between a stale lock and a machine that runs
// private-worker-only until a human deletes a file. Whether anything answers
// on the socket is asked of the caller: this module owns the lock file, not
// the transport.
export async function daemonLockIsAbandoned(
	holder: DaemonLock,
	isListening: () => Promise<boolean>,
	now: number = Date.now(),
): Promise<boolean> {
	if (!isProcessAlive(holder.pid)) return true;
	if (now - holder.startedAt < REUSED_PID_LOCK_AGE_MS) return false;
	return !(await isListening());
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not ours to signal.
		return errnoCode(error) === "EPERM";
	}
}

// A lock written by an older binary has no startedAt; reading it as the epoch
// makes it eligible for the socket probe rather than unreadable, which would
// make it immortal instead.
function decodeLock(raw: string): DaemonLock | null {
	const parsed = parseJsonOrNull<Partial<DaemonLock>>(raw);
	if (typeof parsed?.pid !== "number") return null;
	if (typeof parsed.version !== "string") return null;
	if (typeof parsed.modelId !== "string") return null;
	if (typeof parsed.socketPath !== "string") return null;
	return {
		...parsed,
		startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
	} as DaemonLock;
}

function removeLockFile(lockPath: string): boolean {
	try {
		unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}
