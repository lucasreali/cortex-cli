import { style } from "@/cli/style";
import { runEmbeddingDaemon } from "@/embedding/daemon/main";
import { GEMMA_MODEL } from "@/embedding/model";

// Started detached by the MCP server, never typed — so a terminal on stdin is
// a person who found the name in a process list. Same courtesy as prompt-hook
// and git-hook: say what this is and where the real command lives.
export function runEmbedDaemonCommand(args: string[]): Promise<number> {
	if (process.stdin.isTTY) return Promise.resolve(printHint());
	return runEmbeddingDaemon(args[0] ?? GEMMA_MODEL.modelId);
}

function printHint(): number {
	console.log(
		"cortex embed-daemon is the per-user embedding daemon; MCP servers start",
	);
	console.log(
		"it on demand and share one loaded model over a Unix socket. CLI commands",
	);
	console.log("never use it — they spawn a private worker instead.");
	console.log("\nNothing to run by hand. What you probably want:\n");
	console.log(
		`  ${style.cyan("cortex doctor")}   report the daemon's lock and socket state`,
	);
	console.log("\nKill-switch: CORTEX_NO_DAEMON=1");
	return 0;
}
