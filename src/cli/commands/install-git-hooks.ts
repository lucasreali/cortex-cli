import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { consent, refusal } from "@/cli/confirm";
import { selfCommand } from "@/cli/self-command";
import { failure, style, success, warning } from "@/cli/style";
import { getHooksPath } from "@/git";
import {
	CORTEX_HOOK_EVENTS,
	type HookCommand,
	type HookEvent,
	planHookFile,
	planHookRemoval,
} from "@/install/git-hooks";
import { writeAtomically } from "@/support/atomic-write";
import { tildify } from "@/support/tildify";

type EventOutcome = "done" | "nothing" | "failed";

const INSTALL_VERBS = {
	created: "hook installed",
	appended: "block added to your existing hook",
	updated: "hook updated",
	unchanged: "hook already installed",
} as const;

export async function installGitHooks(
	cwd: string,
	assumeYes: boolean,
): Promise<number> {
	const hooksDir = resolveHooksDir(cwd);
	if (!hooksDir) return 1;
	const consented = consent(
		`Install cortex git hooks in ${display(hooksDir)}?`,
		assumeYes,
	);
	if (consented !== "granted") return refusal(consented);
	mkdirSync(hooksDir, { recursive: true });
	const command = selfCommand();
	const outcomes = await eachEvent((event) =>
		installOne(hooksDir, event, command),
	);
	if (outcomes.includes("failed")) return 1;
	console.log(
		style.dim(
			"Decisions now reconcile on commit, checkout and merge; " +
				"`cortex sync` still forces a full pass.",
		),
	);
	return 0;
}

export async function removeGitHooks(
	cwd: string,
	assumeYes: boolean,
): Promise<number> {
	const hooksDir = resolveHooksDir(cwd);
	if (!hooksDir) return 1;
	const consented = consent(
		`Remove cortex git hooks from ${display(hooksDir)}?`,
		assumeYes,
	);
	if (consented !== "granted") return refusal(consented);
	const outcomes = await eachEvent((event) => removeOne(hooksDir, event));
	if (outcomes.includes("failed")) return 1;
	if (!outcomes.includes("done")) console.log(style.dim("Nothing to remove."));
	return 0;
}

async function eachEvent(
	handle: (event: HookEvent) => Promise<EventOutcome>,
): Promise<EventOutcome[]> {
	const outcomes: EventOutcome[] = [];
	for (const event of CORTEX_HOOK_EVENTS) {
		outcomes.push(await handle(event));
	}
	return outcomes;
}

async function installOne(
	hooksDir: string,
	event: HookEvent,
	command: HookCommand,
): Promise<EventOutcome> {
	const path = join(hooksDir, event);
	if (isSymlink(path)) return sharedHookWarning(event, path);
	const plan = planHookFile({
		event,
		existing: await readIfExists(path),
		command,
	});
	if (plan.action === "skipped") {
		console.log(warning(`${event} — ${plan.reason}`));
		return "failed";
	}
	if (plan.action !== "unchanged") await writeAtomically(path, plan.content);
	// writeAtomically renames a fresh temp file over the target, so the mode
	// the user (or our own first install) set is gone — and git silently skips
	// a hook it cannot execute, which would disable their hook, not just ours.
	chmodSync(path, 0o755);
	console.log(success(`${event} — ${INSTALL_VERBS[plan.action]} (${path})`));
	return "done";
}

async function removeOne(
	hooksDir: string,
	event: HookEvent,
): Promise<EventOutcome> {
	const path = join(hooksDir, event);
	if (isSymlink(path)) return sharedHookWarning(event, path);
	const plan = planHookRemoval(await readIfExists(path));
	if (plan.action === "skipped") {
		console.log(warning(`${event} — ${plan.reason}`));
		return "failed";
	}
	if (plan.action === "absent") return "nothing";
	if (plan.leavesFileEmpty) {
		unlinkSync(path);
		console.log(success(`${event} — hook removed (${path})`));
		return "done";
	}
	await writeAtomically(path, plan.content);
	console.log(success(`${event} — cortex block removed (${path})`));
	return "done";
}

function sharedHookWarning(event: HookEvent, path: string): EventOutcome {
	console.log(
		warning(
			`${event} — ${path} is a symlink, probably shared with other repos; ` +
				"edit it yourself",
		),
	);
	return "failed";
}

function resolveHooksDir(cwd: string): string | null {
	const hooksDir = getHooksPath(cwd);
	if (hooksDir) return hooksDir;
	console.error(failure("git hooks need a git repository — none found here"));
	return null;
}

function isSymlink(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

async function readIfExists(path: string): Promise<string | null> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : null;
}

function display(path: string): string {
	return tildify(path, homedir());
}
