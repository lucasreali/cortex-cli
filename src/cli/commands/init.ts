import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { confirmInteractive } from "@/cli/confirm";
import { style, success, warning } from "@/cli/style";
import { exportDecisionsIfNeeded } from "@/decisions/bootstrap";
import { GEMMA_MODEL } from "@/embedding/model";
import { getCanonicalProjectId, getRepoRoot } from "@/git";
import {
	CORTEX_BLOCK_BEGIN,
	CORTEX_BLOCK_END,
	CORTEX_INSTRUCTIONS_BLOCK,
	upsertMarkedBlock,
} from "@/install/instructions";
import { instructionFilesFor } from "@/install/targets";
import { readConfig, writeConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { migrate, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository } from "@/storage/node-repository";
import {
	CORTEX_DIRECTORY,
	DECISIONS_DIRECTORY,
	ProjectRoot,
} from "@/storage/project-root";
import { writeAtomically } from "@/support/atomic-write";

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
	await ensureInstructionFiles(root, values.yes);

	console.log(success(`Cortex initialized at ${style.cyan(cortexDir)}`));
	console.log(`\n${style.bold("Next steps")}`);
	printStep(1, "Register the MCP server with your agents once, user-wide", [
		"cortex install",
	]);
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
//
// The config is versioned with them because it pins the embedding model: a
// teammate must not silently fill the same store from a different model.
const IGNORE_RULES = [
	`/${CORTEX_DIRECTORY}/*`,
	`!/${CORTEX_DIRECTORY}/config`,
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

async function ensureInstructionFiles(
	root: string,
	assumeYes: boolean,
): Promise<void> {
	const files = instructionFilesFor(homedir(), root);
	if (files.length === 0) {
		console.log(
			style.dim(
				"No coding agents detected — `cortex install` registers the MCP server.",
			),
		);
		return;
	}
	const question = `Add cortex usage instructions to ${files.join(", ")}?`;
	if (!assumeYes && !confirmInteractive(question)) {
		console.log(
			warning("Skipped agent instructions — rerun with --yes to add them."),
		);
		return;
	}
	for (const name of files) {
		await upsertInstructionFile(root, name);
	}
}

async function upsertInstructionFile(
	root: string,
	name: string,
): Promise<void> {
	const path = join(root, name);
	const file = Bun.file(path);
	const existing = (await file.exists()) ? await file.text() : null;
	const result = upsertMarkedBlock(existing, CORTEX_INSTRUCTIONS_BLOCK);
	if (result.action === "skipped-malformed") {
		console.log(
			warning(
				`${name}: found ${CORTEX_BLOCK_BEGIN} without ${CORTEX_BLOCK_END} — fix the markers and rerun`,
			),
		);
		return;
	}
	if (result.action === "unchanged") {
		console.log(success(`${name} — cortex instructions unchanged`));
		return;
	}
	await writeAtomically(path, result.content);
	const verb = result.action === "updated" ? "updated" : "added";
	console.log(success(`${name} — cortex instructions ${verb}`));
}
