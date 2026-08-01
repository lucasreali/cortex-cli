import { readDaemonLock } from "./lock";
import type { DaemonPaths } from "./paths";

// The socket is keyed by model, not by version, so a daemon from the previous
// binary keeps answering and keeps being rejected by the handshake — and a
// rejected probe deliberately never spawns a replacement. Stopping it is what
// lets the shared-daemon rung of the ladder come back after an upgrade.
export function stopDaemon(paths: DaemonPaths): boolean {
	const lock = readDaemonLock(paths.lockPath);
	if (!lock) return false;
	try {
		process.kill(lock.pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}
