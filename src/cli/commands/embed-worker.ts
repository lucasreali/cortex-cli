import { style } from "@/cli/style";
import { runEmbedWorker } from "@/embedding/worker";

// Like prompt-hook and git-hook, this is spawned with pipes on both ends and
// never typed. A terminal on stdin is therefore a person who found the name in
// a process list, and the protocol has nothing to say to them.
export async function runEmbedWorkerCommand(): Promise<number> {
	if (process.stdin.isTTY) return printHint();
	await runEmbedWorker();
	return 0;
}

function printHint(): number {
	console.log(
		"cortex embed-worker is the private embedding subprocess cortex spawns;",
	);
	console.log(
		"it loads the embedding model and answers NDJSON requests on stdio.",
	);
	console.log("\nNothing to run by hand. What you probably want:\n");
	console.log(
		`  ${style.cyan("cortex embed --missing")}   embed new decisions`,
	);
	console.log(
		`  ${style.cyan("cortex embed --fetch-model")}  download the model now`,
	);
	console.log(`  ${style.cyan("cortex doctor")}           check model state`);
	return 0;
}
