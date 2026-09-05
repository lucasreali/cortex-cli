import { fileURLToPath } from "node:url";
import { RUNS_FROM_COMPILED_BINARY } from "@/support/platform";

export interface SubprocessCommand {
	executable: string;
	argv: string[];
}

// A compiled cortex binary cannot execute loose .ts entrypoints: its
// process.execPath is the binary itself and always runs the CLI. The worker
// and daemon are therefore reachable as hidden CLI subcommands, and only a
// source checkout (where execPath is the bun runtime) spawns the files
// directly. Which of the two this is comes from support/platform.

// CORTEX_EMBED_WORKER_PATH names a script to spawn in place of the real worker.
// The daemon has always read it and handed it to its provider; the private
// worker honours it too, which is what lets a test drive a path that spawns one
// — a git hook's detached embed, say — without a model. Same rule as
// CORTEX_RELEASE_BASE_URL, and for the same reason: a variable that chooses
// which program cortex executes is a test seam, never a setting, so an
// installed binary ignores it.
function overriddenWorkerPath(compiled: boolean): string | undefined {
	if (compiled) return undefined;
	return process.env.CORTEX_EMBED_WORKER_PATH || undefined;
}

export function embedWorkerCommand(
	workerPath?: string,
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
): SubprocessCommand {
	const chosen = workerPath ?? overriddenWorkerPath(compiled);
	if (chosen) return { executable: process.execPath, argv: [chosen] };
	if (compiled) return { executable: process.execPath, argv: ["embed-worker"] };
	return {
		executable: process.execPath,
		argv: [fileURLToPath(new URL("./worker.ts", import.meta.url))],
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
		argv: [
			fileURLToPath(new URL("./daemon/main.ts", import.meta.url)),
			modelId,
		],
	};
}
