import { join } from "node:path";
import { userCortexDir } from "@/support/cortex-home";

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
	return userCortexDir("daemon", process.env.CORTEX_DAEMON_DIR);
}

function fileSafe(modelId: string): string {
	return modelId.replace(/[^\w.-]+/g, "-");
}
