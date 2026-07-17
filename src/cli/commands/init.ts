import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GEMMA_MODEL } from "@/embedding/model";
import { getRepoRoot } from "@/git";
import { buildRuntime } from "@/mcp/runtime";
import { readConfig, writeConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";

export async function runInit(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { yes: { type: "boolean", default: false } },
	});
	const runtime = buildRuntime(cwd);
	runtime.dispose();

	const root = getRepoRoot(cwd) ?? resolve(cwd);
	const cortexDir = join(root, ".cortex");
	if (!(await readConfig(cortexDir))) {
		await writeConfig(cortexDir, {
			model_id: GEMMA_MODEL.modelId,
			schema_version: SCHEMA_VERSION,
		});
	}
	await ensureGitignore(root, values.yes);

	console.log(`Cortex initialized at ${cortexDir}`);
	console.log("\nNext steps:");
	console.log("  1. register the MCP server with your agent:");
	console.log("       claude mcp add cortex -- cortex serve --mcp");
	console.log("  2. decisions saved via save_decision become searchable with");
	console.log("       cortex search <terms> | cortex log | cortex why <path>");
	return 0;
}

async function ensureGitignore(
	root: string,
	assumeYes: boolean,
): Promise<void> {
	const path = join(root, ".gitignore");
	const file = Bun.file(path);
	const current = (await file.exists()) ? await file.text() : "";
	if (current.includes(".cortex/code.db")) return;
	if (
		!assumeYes &&
		!confirmInteractive("Add .cortex/code.db* to .gitignore?")
	) {
		console.log(
			"Skipped .gitignore change — add .cortex/code.db* yourself or rerun with --yes.",
		);
		return;
	}
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await Bun.write(path, `${current}${separator}.cortex/code.db*\n`);
	console.log("Added .cortex/code.db* to .gitignore");
}

function confirmInteractive(question: string): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(question);
}
