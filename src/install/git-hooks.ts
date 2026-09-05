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
// Unindented on purpose: `exit` inside an `if` or a function is a branch, and
// only a statement at the top level of the file is one the shell always takes.
const TERMINATES = /^(exit|exec)\b/;
const SHELL_INTERPRETERS = ["sh", "bash", "dash", "zsh", "ksh"];
// Every word is emitted inside double quotes, so spaces and accented paths are
// safe; what must never survive is anything the shell would reinterpret there.
const SAFE_PATH_SEGMENT = /^[\p{L}\p{N}._+@ -]+$/u;
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

export function isShellSafeCommandWord(word: string): boolean {
	const [root = "", ...segments] = word.split("/");
	// An absolute POSIX path leaves the first segment empty; a Windows one
	// leaves the drive there — git runs hooks through the sh it ships with on
	// Windows too, and that shell takes a drive-letter path as long as it is
	// spelled with forward slashes, which is what selfCommand hands over.
	// Anything else is relative, and git hooks run with the minimal PATH of GUI
	// clients and CI runners.
	if (root !== "" && !WINDOWS_DRIVE.test(root)) return false;
	// A root on its own — "" for the empty word, "C:" for a bare drive — names
	// no program, and an empty list would otherwise pass the check below.
	if (segments.length === 0) return false;
	return segments.every(
		(segment) => segment !== ".." && SAFE_PATH_SEGMENT.test(segment),
	);
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
	const source = blank ? POSIX_SHEBANG : (existing ?? "");
	const result = HOOK_BLOCK.upsert(source, body);
	if (result.action === "skipped-malformed") {
		return { action: "skipped", reason: malformedMarkers() };
	}
	const placed = placeAboveTerminal(source, body);
	if (placed) return placed;
	if (blank) return { action: "created", content: result.content };
	return result;
}

// A hook whose last statement is `exit` or `exec` never reaches anything below
// it: the shell leaves at that line, so a block appended after it is dead text
// and the three green lines this prints are a lie — decisions would never
// reconcile on commit again. Generated and husky-style hooks end that way
// often enough that refusing them all would be the wrong trade, so the block
// goes immediately above that final statement instead, which is where it would
// have been written by hand. An `exit` anywhere else is a branch this cannot
// read, and a block that is already installed is an arrangement to leave
// alone; both fall through to the ordinary upsert, and only a hook that would
// swallow a *new* block is refused.
function placeAboveTerminal(source: string, body: string): HookPlan | null {
	// The markers were read by the upsert above, so this cannot find them
	// half-written; what it needs from the removal is only where they were.
	const removal = HOOK_BLOCK.remove(source);
	const installed = removal.action === "removed";
	const lines = (
		installed && "content" in removal ? removal.content : source
	).split("\n");
	const terminal = terminalStatementLine(lines);
	if (terminal === null) {
		return installed ? null : refusalWhenUnreachable(lines);
	}
	const content = insertBefore(lines, terminal, HOOK_BLOCK.fence(body));
	if (content === source) return { action: "unchanged", content };
	return { action: installed ? "updated" : "appended", content };
}

function terminalStatementLine(lines: readonly string[]): number | null {
	const last = lastStatementLine(lines);
	if (last === null) return null;
	return TERMINATES.test(lines[last] ?? "") ? last : null;
}

function lastStatementLine(lines: readonly string[]): number | null {
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (isStatement(lines[index] ?? "")) return index;
	}
	return null;
}

function isStatement(line: string): boolean {
	const text = line.trim();
	return text !== "" && !text.startsWith("#");
}

function refusalWhenUnreachable(lines: readonly string[]): HookPlan | null {
	const statement = lines.find((line) => TERMINATES.test(line));
	if (statement === undefined) return null;
	return {
		action: "skipped",
		reason: `the existing hook runs \`${statement.trim()}\` before its end — the block would never run there, so add it yourself`,
	};
}

function insertBefore(
	lines: readonly string[],
	at: number,
	block: string,
): string {
	const head = [...lines.slice(0, at)];
	while (head.length > 0 && head[head.length - 1]?.trim() === "") head.pop();
	return [...head, "", block, "", ...lines.slice(at)].join("\n");
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
