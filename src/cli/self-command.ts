import { realpathSync } from "node:fs";
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
	const executable = portable(
		compiled ? stableBinaryPath() : currentBinaryPath(),
	);
	if (compiled) return { executable, args };
	return { executable, args: [portable(entryPath), ...args] };
}

// The path a hook is written with outlives this binary. Homebrew and similar
// managers install into a versioned directory and link it from bin/: the
// resolved path is gone after the next upgrade, and a hook naming it fails in
// silence on every commit from then on. The `cortex` on PATH, when it is this
// same file, is the name that survives.
export function stableBinaryPath(
	which: (command: string) => string | null = Bun.which,
): string {
	const running = currentBinaryPath();
	const onPath = which("cortex");
	if (onPath && resolvesTo(onPath, running)) return onPath;
	return running;
}

function resolvesTo(path: string, target: string): boolean {
	try {
		return realpathSync(path) === target;
	} catch {
		return false;
	}
}

// One of the two consumers is a git hook, which git runs through the sh it
// ships on Windows as well, and that shell reads a backslash as an escape
// rather than a separator. Forward slashes are the one spelling both it and the
// Win32 API accept, so the conversion belongs here — where the path is produced
// — rather than in each place that has to quote it.
function portable(path: string): string {
	return path.replaceAll("\\", "/");
}
