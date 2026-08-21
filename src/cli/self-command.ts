import { RUNS_FROM_COMPILED_BINARY } from "@/embedding/subprocess-command";
import type { HookCommand } from "@/install/git-hooks";
import { currentBinaryPath } from "@/release/installer";

// How to invoke this same cortex from somewhere that does not inherit our PATH
// — a git hook, or a detached child. A compiled binary is one word; a source
// checkout is the bun runtime plus the CLI entrypoint.
export function selfCommand(
	args: readonly string[] = [],
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
	entryPath: string = new URL("./main.ts", import.meta.url).pathname,
): HookCommand {
	const executable = currentBinaryPath();
	if (compiled) return { executable, args };
	return { executable, args: [entryPath, ...args] };
}
