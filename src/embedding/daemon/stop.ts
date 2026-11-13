import { greetingPid } from "./client";
import { type DaemonLock, readDaemonLock } from "./lock";
import type { DaemonPaths } from "./paths";

// The socket is keyed by model, not by version, so a daemon from the previous
// binary keeps answering and keeps being rejected by the handshake — and a
// rejected probe deliberately never spawns a replacement. Stopping it is what
// lets the shared-daemon rung of the ladder come back after an upgrade.
//
// The lock file survives a crash and a reboot, and its pid is eventually
// reused by something unrelated: signalling it unverified could terminate any
// process of the user's. Only the pid the daemon itself announces on its socket
// is signalled, and only when it matches the lock.
export async function stopDaemon(
	paths: DaemonPaths,
	announcedPid: (
		paths: DaemonPaths,
		holder: DaemonLock,
	) => Promise<number | null> = greetingPid,
): Promise<boolean> {
	const lock = readDaemonLock(paths.lockPath);
	if (!lock) return false;
	if ((await announcedPid(paths, lock)) !== lock.pid) return false;
	try {
		process.kill(lock.pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
