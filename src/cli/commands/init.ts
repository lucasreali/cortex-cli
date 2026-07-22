import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { GEMMA_MODEL } from "@/embedding/model";
import { getCanonicalProjectId, getRepoRoot } from "@/git";
import { readConfig, writeConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { migrate, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import { style, success, warning } from "../style";

export async function runInit(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { yes: { type: "boolean", default: false } },
	});
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	const cortexDir = join(root, ".cortex");
	await initializeStorage(root, cortexDir);
	if (!(await readConfig(cortexDir))) {
		await writeConfig(cortexDir, {
			model_id: GEMMA_MODEL.modelId,
			schema_version: SCHEMA_VERSION,
		});
	}
	await ensureGitignore(root, values.yes);

	console.log(success(`Cortex initialized at ${style.cyan(cortexDir)}`));
	console.log(`\n${style.bold("Next steps")}`);
	printStep(1, "Register the MCP server with your agent", [
		"claude mcp add cortex -- cortex serve --mcp",
	]);
	printStep(2, "Save decisions with save_decision, then explore them", [
		"cortex search <terms>",
		"cortex log",
		"cortex why <path>",
	]);
	return 0;
}

function printStep(step: number, title: string, commands: string[]): void {
	console.log(`  ${step}. ${title}`);
	for (const command of commands) {
		console.log(`       ${style.dim("$")} ${style.cyan(command)}`);
	}
}

async function initializeStorage(
	root: string,
	cortexDir: string,
): Promise<void> {
	const decisionsDir = join(cortexDir, "decisions");
	mkdirSync(decisionsDir, { recursive: true });
	// Git only tracks files: without this a cloned repo with zero decisions
	// would lack the directory and wrongly trigger the bootstrap export.
	await Bun.write(join(decisionsDir, ".gitkeep"), "");
	const db = openDecisionsDb(cortexDir);
	try {
		migrate(db);
		new NodeRepository(db).ensureProject(getCanonicalProjectId(root) ?? root);
	} finally {
		db.close();
	}
}

async function ensureGitignore(
	root: string,
	assumeYes: boolean,
): Promise<void> {
	const path = join(root, ".gitignore");
	const file = Bun.file(path);
	const current = (await file.exists()) ? await file.text() : "";
	if (current.includes(".cortex/*.db*")) return;
	if (!assumeYes && !confirmInteractive("Add .cortex/*.db* to .gitignore?")) {
		console.log(
			warning(
				"Skipped .gitignore change — add .cortex/*.db* yourself or rerun with --yes. " +
					"Databases are local caches; .cortex/decisions/ and .cortex/config are meant to be committed.",
			),
		);
		return;
	}
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await Bun.write(path, `${current}${separator}.cortex/*.db*\n`);
	console.log(success("Added .cortex/*.db* to .gitignore"));
}

function confirmInteractive(question: string): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(question);
}
