export interface SubprocessCommand {
	executable: string;
	argv: string[];
}

// A compiled cortex binary cannot execute loose .ts entrypoints: its
// process.execPath is the binary itself and always runs the CLI. The worker
// and daemon are therefore reachable as hidden CLI subcommands, and only a
// source checkout (where execPath is the bun runtime) spawns the files
// directly. "$bunfs" is the embedded-filesystem prefix Bun gives every
// module inside a compiled binary.
export const RUNS_FROM_COMPILED_BINARY: boolean = import.meta.url.includes(
	"$bunfs",
);

export function embedWorkerCommand(
	workerPath?: string,
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
): SubprocessCommand {
	if (workerPath) return { executable: process.execPath, argv: [workerPath] };
	if (compiled) return { executable: process.execPath, argv: ["embed-worker"] };
	return {
		executable: process.execPath,
		argv: [new URL("./worker.ts", import.meta.url).pathname],
	};
}

export function embedDaemonCommand(
	modelId: string,
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
): SubprocessCommand {
	if (compiled) {
		return { executable: process.execPath, argv: ["embed-daemon", modelId] };
	}
	return {
		executable: process.execPath,
		argv: [new URL("./daemon/main.ts", import.meta.url).pathname, modelId],
	};
}
