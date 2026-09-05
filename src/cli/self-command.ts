import { fileURLToPath } from "node:url";
import type { HookCommand } from "@/install/git-hooks";
import { currentBinaryPath } from "@/release/installer";
import { RUNS_FROM_COMPILED_BINARY } from "@/support/platform";

// How to invoke this same cortex from somewhere that does not inherit our PATH
// — a git hook, or a detached child. A compiled binary is one word; a source
// checkout is the bun runtime plus the CLI entrypoint.
export function selfCommand(
	args: readonly string[] = [],
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
	entryPath: string = fileURLToPath(new URL("./main.ts", import.meta.url)),
): HookCommand {
	const executable = portable(currentBinaryPath());
	if (compiled) return { executable, args };
	return { executable, args: [portable(entryPath), ...args] };
}

// One of the two consumers is a git hook, which git runs through the sh it
// ships on Windows as well, and that shell reads a backslash as an escape
// rather than a separator. Forward slashes are the one spelling both it and the
// Win32 API accept, so the conversion belongs here — where the path is produced
// — rather than in each place that has to quote it.
function portable(path: string): string {
	return path.replaceAll("\\", "/");
}
