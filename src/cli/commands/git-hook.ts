import { existsSync } from "node:fs";
import { selfCommand } from "@/cli/self-command";
import { exportDecisionsIfNeeded } from "@/decisions/bootstrap";
import { openDecisionSync } from "@/decisions/decision-sync";
import { GEMMA_MODEL } from "@/embedding/model";
import { replayStepsRemaining } from "@/git/replay";
import {
	type HookEvent,
	hookEventActs,
	parseHookEvent,
} from "@/install/git-hooks";
import { readConfig } from "@/storage/config";
import { openDecisionsDb } from "@/storage/connection";
import { EmbeddingRepository } from "@/storage/embedding-repository";
import { migrate } from "@/storage/migrations";
import { ProjectRoot } from "@/storage/project-root";

// The command the installed git hooks call. LOAD-BEARING: it must never fail a
// commit, a checkout or a merge, so every path — kill-switch, unknown event, no
// store, corrupt store — returns 0 with no output.
//
// It is prompt-hook's mirror image: reconciling is the whole job, so the store
// is opened read-write. What it will not do is create one, which is why the
// database file is checked before anything opens it.
export async function runGitHook(args: string[], cwd: string): Promise<number> {
	try {
		if (process.env.CORTEX_NO_GIT_HOOK === "1") return 0;
		const event = parseHookEvent(args[0]);
		if (!event) return printInstallHint();
		if (!hookEventActs(event, args.slice(1))) return 0;
		await reconcileProject(event, cwd);
	} catch {}
	return 0;
}

async function reconcileProject(event: HookEvent, cwd: string): Promise<void> {
	// Not getRepoRoot: git exports GIT_DIR to its hooks, and during submodule
	// operations it names the superproject. Walking up from cwd cannot answer
	// for the wrong repository, and costs no subprocess.
	const project = ProjectRoot.nearest(cwd);
	if (!project || !existsSync(project.decisionsDbPath)) return;
	const modelId = await pinnedModelId(project.cortexDir);
	if (reconcile(project, embedsAfter(event, cwd) ? modelId : null)) {
		spawnEmbedMissing(project.directory);
	}
}

// Reports whether embedding is pending, because the answer has to be read from
// the same connection the reconcile ran on: reconciling is synchronous by
// design, and reopening the store to ask would race the hook that follows.
function reconcile(project: ProjectRoot, modelId: string | null): boolean {
	const db = openDecisionsDb(project.cortexDir);
	try {
		exportDecisionsIfNeeded(project.cortexDir, db, migrate(db));
		openDecisionSync({ cortexDir: project.cortexDir, db }).resync();
		if (!modelId) return false;
		return new EmbeddingRepository(db).listMissingNodeIds(modelId).length > 0;
	} finally {
		db.close();
	}
}

// Only a commit or a merge brings decisions that were never embedded here: a
// checkout restores rows that kept their vectors, because nothing is deleted
// when a branch goes away.
//
// The replay guard is the other half, and the measurement behind it is git
// 2.53 with the merge backend: a rebase fires post-checkout once, moving onto
// the new base, and post-commit once per replayed commit — so fifty replayed
// commits would spawn fifty detached embeds, each loading the model. While the
// sequencer still has steps to run the embed is left to the last of them,
// whose todo is empty by the time this hook sees it, and one embed covers
// everything the replay brought.
function embedsAfter(event: HookEvent, cwd: string): boolean {
	if (process.env.CORTEX_DISABLE_EMBEDDINGS === "1") return false;
	if (event === "post-checkout") return false;
	return !replayStepsRemaining(cwd);
}

async function pinnedModelId(cortexDir: string): Promise<string> {
	const config = await readConfig(cortexDir);
	return config?.model_id ?? GEMMA_MODEL.modelId;
}

function spawnEmbedMissing(directory: string): void {
	const command = selfCommand(["embed", "--missing"]);
	const child = Bun.spawn([command.executable, ...command.args], {
		cwd: directory,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	child.unref();
}

function printInstallHint(): number {
	console.log("cortex git-hook is called by the git hooks cortex installs; it");
	console.log(
		"reconciles this project's decisions after a commit, a branch switch",
	);
	console.log("or a merge, and never fails the git operation that ran it.");
	console.log("\nInstall the hooks in this repository:\n");
	console.log("  cortex install --git-hooks");
	console.log("\nKill-switch: CORTEX_NO_GIT_HOOK=1");
	return 0;
}
