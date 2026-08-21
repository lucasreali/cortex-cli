import { MarkedBlock } from "./marked-block";

export const CORTEX_HOOK_BEGIN = "# cortex-hook-start";
export const CORTEX_HOOK_END = "# cortex-hook-end";
export const HOOK_BLOCK = new MarkedBlock(CORTEX_HOOK_BEGIN, CORTEX_HOOK_END);

export const CORTEX_HOOK_EVENTS = [
	"post-commit",
	"post-checkout",
	"post-merge",
] as const;

export type HookEvent = (typeof CORTEX_HOOK_EVENTS)[number];

// A command, not a path: from a source checkout cortex is `bun main.ts`, two
// words, and git runs hooks with the minimal PATH of GUI clients and CI
// runners, so nothing may be left to resolution at trigger time.
export interface HookCommand {
	executable: string;
	args: readonly string[];
}

export type HookPlan =
	| {
			action: "created" | "appended" | "updated" | "unchanged";
			content: string;
	  }
	| { action: "skipped"; reason: string };

export type HookRemovalPlan =
	| { action: "removed"; content: string; leavesFileEmpty: boolean }
	| { action: "absent" }
	| { action: "skipped"; reason: string };

const POSIX_SHEBANG = "#!/bin/sh\n";
const SHELL_INTERPRETERS = ["sh", "bash", "dash", "zsh", "ksh"];
// Every word is emitted inside double quotes, so spaces and accented paths are
// safe; what must never survive is anything the shell would reinterpret there.
const SAFE_PATH_SEGMENT = /^[\p{L}\p{N}._+@ -]+$/u;

export function isShellSafeCommandWord(word: string): boolean {
	if (!word.startsWith("/")) return false;
	return word
		.slice(1)
		.split("/")
		.every((segment) => segment !== ".." && SAFE_PATH_SEGMENT.test(segment));
}

export function buildHookBody(event: HookEvent, command: HookCommand): string {
	const call = [command.executable, ...command.args].map(quote).join(" ");
	return [
		"# Managed by cortex. Update: cortex install --git-hooks.",
		"# Remove: cortex install --git-hooks --uninstall.",
		"# No exit and no set -e on purpose: whatever you add below must still run.",
		`if [ -x ${quote(command.executable)} ]; then`,
		`  ${call} git-hook ${event} "$@" || true`,
		"fi",
	].join("\n");
}

export function planHookFile(input: {
	event: HookEvent;
	existing: string | null;
	command: HookCommand;
}): HookPlan {
	const unsafe = [input.command.executable, ...input.command.args].find(
		(word) => !isShellSafeCommandWord(word),
	);
	if (unsafe !== undefined) {
		return {
			action: "skipped",
			reason: `refusing to pin ${unsafe} — a shell would reinterpret that path`,
		};
	}
	const rejection = reasonToLeaveAlone(input.existing);
	if (rejection) return { action: "skipped", reason: rejection };
	return write(input.existing, buildHookBody(input.event, input.command));
}

export function planHookRemoval(existing: string | null): HookRemovalPlan {
	const removal = HOOK_BLOCK.remove(existing);
	if (removal.action === "skipped-malformed") {
		return { action: "skipped", reason: malformedMarkers() };
	}
	if (removal.action === "absent") return { action: "absent" };
	return {
		action: "removed",
		content: removal.content,
		leavesFileEmpty: isBlankOrShebang(removal.content),
	};
}

// post-checkout runs on `git checkout -- <path>` too, where its third argument
// is 0 and no branch changed; git rebase replays it once per commit.
export function hookEventActs(
	event: HookEvent,
	gitArgs: readonly string[],
): boolean {
	if (event !== "post-checkout") return true;
	return gitArgs[2] === "1";
}

export function parseHookEvent(value: string | undefined): HookEvent | null {
	return CORTEX_HOOK_EVENTS.find((event) => event === value) ?? null;
}

function write(existing: string | null, body: string): HookPlan {
	const blank = isBlank(existing);
	const result = HOOK_BLOCK.upsert(blank ? POSIX_SHEBANG : existing, body);
	if (result.action === "skipped-malformed") {
		return { action: "skipped", reason: malformedMarkers() };
	}
	if (blank) return { action: "created", content: result.content };
	return result;
}

// Appending `if [ -x … ]` to a hook the user wrote in another language is a
// syntax error that fails the commit — the one outcome this feature promises
// can never happen. Refuse instead, and say which language was found.
function reasonToLeaveAlone(existing: string | null): string | null {
	if (existing === null) return null;
	if (existing.includes("\0")) {
		return "the existing hook is a binary file — add the block yourself";
	}
	const interpreter = foreignInterpreter(existing);
	if (!interpreter) return null;
	return `the existing hook is a ${interpreter} script — add the block yourself`;
}

function foreignInterpreter(existing: string): string | null {
	const [first = ""] = existing.split("\n");
	if (!first.startsWith("#!")) return null;
	const [command = "", next = ""] = first.slice(2).trim().split(/\s+/);
	const viaEnv = command === "env" || command.endsWith("/env");
	const name = basename(viaEnv ? next : command);
	// `#!` with nothing after it is not an interpreter at all; sh reads the
	// line as a comment, so the block is safe to append.
	if (name === "" || SHELL_INTERPRETERS.includes(name)) return null;
	return name;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function isBlank(text: string | null): boolean {
	return text === null || text.trim() === "";
}

function isBlankOrShebang(text: string): boolean {
	const lines = text.split("\n").filter((line) => line.trim() !== "");
	if (lines.length === 0) return true;
	return lines.length === 1 && lines[0]?.startsWith("#!") === true;
}

function malformedMarkers(): string {
	return `found ${CORTEX_HOOK_BEGIN} without ${CORTEX_HOOK_END} — fix the markers and rerun`;
}

function quote(word: string): string {
	return `"${word}"`;
}
