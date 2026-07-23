import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DaemonLock {
	pid: number;
	version: string;
	modelId: string;
	socketPath: string;
	startedAt: number;
}

// "wx" keeps acquisition atomic and exclusive: whoever creates the file owns
// the daemon role. Readers never clear a lock they cannot decode (see
// clearDeadDaemonLock), so the brief create-then-write window in which the
// file exists empty can be misread but never produces two daemons.
export function acquireDaemonLock(lockPath: string, lock: DaemonLock): boolean {
	mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(lockPath, JSON.stringify(lock), { flag: "wx", mode: 0o600 });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
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

// Compare-and-delete: re-reads the lock and only unlinks while it still names
// the pid the caller saw dead, so a racing daemon's fresh lock survives.
export function clearDeadDaemonLock(
	lockPath: string,
	expectedDeadPid: number,
): boolean {
	const current = readDaemonLock(lockPath);
	if (!current) return false;
	if (current.pid !== expectedDeadPid) return false;
	if (isProcessAlive(current.pid)) return false;
	return removeLockFile(lockPath);
}

export function releaseDaemonLock(lockPath: string, ownPid: number): void {
	const current = readDaemonLock(lockPath);
	if (current?.pid !== ownPid) return;
	removeLockFile(lockPath);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but is not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function decodeLock(raw: string): DaemonLock | null {
	const parsed = JSON.parse(raw) as Partial<DaemonLock>;
	if (typeof parsed?.pid !== "number") return null;
	if (typeof parsed.version !== "string") return null;
	if (typeof parsed.modelId !== "string") return null;
	if (typeof parsed.socketPath !== "string") return null;
	return parsed as DaemonLock;
}

function removeLockFile(lockPath: string): boolean {
	try {
		unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}
