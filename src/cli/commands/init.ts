import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { style, success, warning } from "@/cli/style";
import { exportDecisionsIfNeeded } from "@/decisions/bootstrap";
import { DECISIONS_DIRECTORY } from "@/decisions/decision-store";
import { GEMMA_MODEL } from "@/embedding/model";
import { getCanonicalProjectId, getRepoRoot } from "@/git";
import { readConfig, writeConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { migrate, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import { CORTEX_DIRECTORY, ProjectRoot } from "@/storage/project-root";

export async function runInit(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { yes: { type: "boolean", default: false } },
	});
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	const cortexDir = ProjectRoot.at(root).cortexDir;
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
	printStep(3, "Commit each decision file alongside the code it governs", [
		"git add .cortex/decisions",
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
		exportDecisionsIfNeeded(cortexDir, db, migrate(db));
		new NodeRepository(db).ensureProject(getCanonicalProjectId(root) ?? root);
	} finally {
		db.close();
	}
}

// Excluding the children rather than the directory itself is what lets the
// negation work at all: git never descends into an excluded directory, so
// `/.cortex/` would hide `decisions/` no matter what followed it.
const IGNORE_RULES = [
	`/${CORTEX_DIRECTORY}/*`,
	`!/${CORTEX_DIRECTORY}/${DECISIONS_DIRECTORY}/`,
];

async function ensureGitignore(
	root: string,
	assumeYes: boolean,
): Promise<void> {
	const path = join(root, ".gitignore");
	const file = Bun.file(path);
	const current = (await file.exists()) ? await file.text() : "";
	if (alreadyRuled(current)) return;
	if (
		!assumeYes &&
		!confirmInteractive("Version .cortex/decisions/ and ignore the rest?")
	) {
		console.log(
			warning(
				`Skipped .gitignore change — add ${IGNORE_RULES.join(" and ")} ` +
					"yourself or rerun with --yes.",
			),
		);
		return;
	}
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	await Bun.write(path, `${current}${separator}${IGNORE_RULES.join("\n")}\n`);
	console.log(
		success("Decisions will be versioned; the SQLite cache stays local"),
	);
}

function alreadyRuled(gitignore: string): boolean {
	const entries = gitignore.split("\n").map((line) => line.trim());
	return IGNORE_RULES.every((rule) => entries.includes(rule));
}

function confirmInteractive(question: string): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(question);
}
