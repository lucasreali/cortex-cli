import { homedir } from "node:os";
import { join } from "node:path";

export interface DaemonPaths {
	directory: string;
	socketPath: string;
	lockPath: string;
	logPath: string;
}

export function daemonPathsFor(
	modelId: string,
	directory: string = defaultDaemonDirectory(),
): DaemonPaths {
	const base = fileSafe(modelId);
	return {
		directory,
		socketPath: join(directory, `${base}.sock`),
		lockPath: join(directory, `${base}.lock`),
		logPath: join(directory, `${base}.log`),
	};
}

export function defaultDaemonDirectory(): string {
	return process.env.CORTEX_DAEMON_DIR ?? join(homedir(), ".cortex", "daemon");
}

function fileSafe(modelId: string): string {
	return modelId.replace(/[^\w.-]+/g, "-");
}
