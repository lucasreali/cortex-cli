import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { style, success, warning } from "@/cli/style";
import { GEMMA_MODEL } from "@/embedding/model";
import { getCanonicalProjectId, getRepoRoot } from "@/git";
import { readConfig, writeConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { migrate, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";

export async function runInit(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { yes: { type: "boolean", default: false } },
	});
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	const cortexDir = join(root, ".cortex");
	initializeStorage(root, cortexDir);
	if (!(await readConfig(cortexDir))) {
		await writeConfig(cortexDir, {
			model_id: GEMMA_MODEL.modelId,
			schema_version: SCHEMA_VERSION,
		});
	}
	await ensureGitignore(root, values.yes);

	console.log(success(`Cortex initialized at ${style.cyan(cortexDir)}`));
	console.log(`\n${style.bold("Next steps")}`);
	printStep(
		1,
		"Register the MCP server once, user-wide (serves every project)",
		["claude mcp add --scope user cortex -- cortex serve --mcp"],
	);
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

function initializeStorage(root: string, cortexDir: string): void {
	mkdirSync(cortexDir, { recursive: true });
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
	if (ignoresCortexDir(current)) return;
	if (!assumeYes && !confirmInteractive("Add .cortex/ to .gitignore?")) {
		console.log(
			warning(
				"Skipped .gitignore change — add .cortex/ yourself or rerun with --yes.",
			),
		);
		return;
	}
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await Bun.write(path, `${current}${separator}.cortex/\n`);
	console.log(success("Added .cortex/ to .gitignore"));
}

function ignoresCortexDir(gitignore: string): boolean {
	const entries = gitignore.split("\n").map((line) => line.trim());
	return entries.includes(".cortex/") || entries.includes(".cortex");
}

function confirmInteractive(question: string): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(question);
}
