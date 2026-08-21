import { chmodSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
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
	const existing = await readIfExists(path);
	const plan = planHookFile({ event, existing, command });
	if (plan.action === "skipped") {
		console.log(warning(`${event} — ${plan.reason}`));
		return "failed";
	}
	if (plan.action !== "unchanged") await writeAtomically(path, plan.content);
	ensureExecutable(path, existing === null);
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

// git silently skips a hook it cannot execute, so the block has to be reachable
// — but a hook the user chmodded 0700 is a decision, and 0755 would publish it
// to their group and to everyone else. Mirror `chmod +x`: an execute bit
// wherever there is already a read bit, and no chmod at all when the mode
// already says executable, so the write path only ever adds permission it needs.
// A hook we created has no mode of its own to keep; writeAtomically left it at
// the umask default, which is not executable.
function ensureExecutable(path: string, created: boolean): void {
	if (created) {
		chmodSync(path, 0o755);
		return;
	}
	const mode = statSync(path).mode & 0o777;
	const executable = mode | ((mode & 0o444) >> 2);
	if (executable !== mode) chmodSync(path, executable);
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
