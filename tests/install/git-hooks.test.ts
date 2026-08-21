import { describe, expect, test } from "bun:test";
import {
	buildHookBody,
	CORTEX_HOOK_BEGIN,
	CORTEX_HOOK_END,
	type HookCommand,
	hookEventActs,
	isShellSafeCommandWord,
	parseHookEvent,
	planHookFile,
	planHookRemoval,
} from "@/install/git-hooks";

const COMPILED: HookCommand = { executable: "/usr/local/bin/cortex", args: [] };
const FROM_SOURCE: HookCommand = {
	executable: "/home/dev/.bun/bin/bun",
	args: ["/home/dev/cortex-cli/src/cli/main.ts"],
};

function plan(existing: string | null, command: HookCommand = COMPILED) {
	return planHookFile({ event: "post-commit", existing, command });
}

function buildBlock(command: HookCommand = COMPILED): string {
	return `${CORTEX_HOOK_BEGIN}\n${buildHookBody("post-commit", command)}\n${CORTEX_HOOK_END}`;
}

function written(existing: string | null, command: HookCommand = COMPILED) {
	const result = plan(existing, command);
	if (!("content" in result)) throw new Error(`skipped: ${result.action}`);
	return result.content;
}

describe("isShellSafeCommandWord", () => {
	const safe = [
		"/usr/local/bin/cortex",
		"/home/dev/.local/bin/cortex",
		"/Users/First Last/bin/cortex",
		"/home/josé/bin/cortex",
		"/opt/cortex-1.2+3@edge/cortex",
	];
	for (const word of safe) {
		test(`accepts ${word}`, () => {
			expect(isShellSafeCommandWord(word)).toBe(true);
		});
	}

	const unsafe = [
		"",
		"cortex",
		"bin/cortex",
		"~/bin/cortex",
		"/bin/cortex; rm -rf /",
		"/bin/$(id)/cortex",
		"/bin/`id`/cortex",
		'/bin/"cortex"',
		"/bin/cortex&",
		"/bin/cortex|tee",
		"/bin/cor*tex",
		"/bin\\cortex",
		"/bin/cortex\nrm",
		"/bin/cortex\t",
		"/home/dev/../root/cortex",
		"/home//cortex",
		"/home/dev/",
	];
	for (const word of unsafe) {
		test(`rejects ${JSON.stringify(word)}`, () => {
			expect(isShellSafeCommandWord(word)).toBe(false);
		});
	}
});

describe("buildHookBody", () => {
	test("quotes every pinned word and forwards git's arguments", () => {
		const body = buildHookBody("post-checkout", FROM_SOURCE);
		expect(body).toContain(
			'"/home/dev/.bun/bin/bun" "/home/dev/cortex-cli/src/cli/main.ts" ' +
				'git-hook post-checkout "$@" || true',
		);
		expect(body).toContain('if [ -x "/home/dev/.bun/bin/bun" ]; then');
		expect(body).toContain("fi");
	});

	// The block lives inside a file the user owns and may extend below it, so
	// it must not change the shell's exit or error semantics for those lines.
	test("never exits or changes shell options", () => {
		const code = buildHookBody("post-commit", COMPILED)
			.split("\n")
			.filter((line) => !line.startsWith("#"))
			.join("\n");
		expect(code).not.toContain("exit");
		expect(code).not.toContain("set -e");
		expect(code).not.toContain("set -u");
	});

	test("carries no markers of its own", () => {
		const body = buildHookBody("post-merge", COMPILED);
		expect(body).not.toContain(CORTEX_HOOK_BEGIN);
		expect(body).not.toContain(CORTEX_HOOK_END);
	});
});

describe("planHookFile", () => {
	test("creates a POSIX hook when there is no file", () => {
		const result = plan(null);
		expect(result.action).toBe("created");
		expect(written(null)).toStartWith("#!/bin/sh\n");
		expect(written(null)).toContain(CORTEX_HOOK_BEGIN);
		expect(written(null)).toContain(CORTEX_HOOK_END);
	});

	test("an empty hook file is created too", () => {
		expect(plan("  \n").action).toBe("created");
	});

	test("appends to a hook the user already owns", () => {
		const mine = '#!/bin/sh\necho "mine"\n';
		const result = plan(mine);
		expect(result.action).toBe("appended");
		expect(written(mine)).toStartWith(mine);
	});

	test("a hook without a shebang is still shell", () => {
		expect(plan('echo "mine"\n').action).toBe("appended");
	});

	test("re-planning the same hook is unchanged", () => {
		const installed = written(null);
		expect(plan(installed)).toEqual({
			action: "unchanged",
			content: installed,
		});
	});

	test("a moved binary replaces the block and keeps the user's lines", () => {
		const installed = written('#!/bin/sh\necho "mine"\n', FROM_SOURCE);
		const result = plan(installed, COMPILED);
		expect(result.action).toBe("updated");
		if (!("content" in result)) throw new Error("expected a write");
		expect(result.content).toContain('echo "mine"');
		expect(result.content).not.toContain("/home/dev/.bun/bin/bun");
		expect(result.content).toContain("/usr/local/bin/cortex");
	});

	const foreign = [
		{ shebang: "#!/usr/bin/env python3", name: "python3" },
		{ shebang: "#!/usr/bin/ruby", name: "ruby" },
		{ shebang: "#!/usr/bin/env -S deno run", name: "-S" },
	];
	for (const { shebang, name } of foreign) {
		test(`refuses a ${name} hook`, () => {
			const result = plan(`${shebang}\nprint(1)\n`);
			expect(result).toEqual({
				action: "skipped",
				reason: `the existing hook is a ${name} script — add the block yourself`,
			});
		});
	}

	const shells = [
		"#!/bin/bash",
		"#!/usr/bin/env bash",
		"#!/bin/dash",
		"#!/bin/zsh -e",
		"#!/usr/bin/ksh",
		"#!",
	];
	for (const shebang of shells) {
		test(`accepts ${JSON.stringify(shebang)}`, () => {
			expect(plan(`${shebang}\necho hi\n`).action).toBe("appended");
		});
	}

	test("refuses a compiled hook", () => {
		const result = plan("\u0000ELF binary");
		expect(result).toEqual({
			action: "skipped",
			reason: "the existing hook is a binary file — add the block yourself",
		});
	});

	test("refuses a half-written block", () => {
		const result = plan(`#!/bin/sh\n${CORTEX_HOOK_BEGIN}\nhalf\n`);
		expect(result).toEqual({
			action: "skipped",
			reason: `found ${CORTEX_HOOK_BEGIN} without ${CORTEX_HOOK_END} — fix the markers and rerun`,
		});
	});

	test("refuses to pin a path a shell would reinterpret", () => {
		const result = plan(null, { executable: "/bin/cortex; id", args: [] });
		expect(result).toEqual({
			action: "skipped",
			reason:
				"refusing to pin /bin/cortex; id — a shell would reinterpret that path",
		});
	});

	test("checks the pinned arguments too", () => {
		const result = plan(null, {
			executable: "/usr/local/bin/bun",
			args: ["$(pwd)/main.ts"],
		});
		expect(result).toMatchObject({ action: "skipped" });
	});
});

// M36: `reasonToLeaveAlone` refused foreign interpreters, but a POSIX-sh hook
// ending in `exit 0` — the shape husky and every hook generator writes — was
// accepted and the block went below it, where the shell never arrives. Three
// green lines, and decisions stop reconciling on commit.
describe("a hook whose last statement ends the script", () => {
	const terminators = ["exit 0", "exit", "exit 1", 'exec "$@"'];

	for (const terminator of terminators) {
		test(`puts the block above ${terminator}`, () => {
			const existing = `#!/bin/sh\necho "mine"\n${terminator}\n`;
			const result = plan(existing);
			expect(result.action).toBe("appended");
			const content = written(existing);
			expect(content.indexOf(CORTEX_HOOK_END)).toBeLessThan(
				content.lastIndexOf(`\n${terminator}\n`),
			);
			expect(content).toEndWith(`${terminator}\n`);
			expect(content).toContain('echo "mine"');
		});
	}

	test("a trailing comment does not hide the terminator", () => {
		const content = written("#!/bin/sh\nexit 0\n\n# done\n");
		expect(content.indexOf(CORTEX_HOOK_END)).toBeLessThan(
			content.lastIndexOf("\nexit 0\n"),
		);
	});

	test("re-planning what it just wrote is unchanged", () => {
		const installed = written('#!/bin/sh\necho "mine"\nexit 0\n');
		expect(plan(installed)).toEqual({
			action: "unchanged",
			content: installed,
		});
	});

	test("lifts a block an older cortex stranded below the terminator", () => {
		const stranded = `#!/bin/sh\nexit 0\n\n${buildBlock()}\n`;
		const result = plan(stranded);
		expect(result.action).toBe("updated");
		const content = written(stranded);
		expect(content.indexOf(CORTEX_HOOK_END)).toBeLessThan(
			content.lastIndexOf("\nexit 0\n"),
		);
		expect(content.match(new RegExp(CORTEX_HOOK_BEGIN, "g"))).toHaveLength(1);
	});

	test("still refuses a half-written block", () => {
		expect(plan(`#!/bin/sh\n${CORTEX_HOOK_BEGIN}\nhalf\nexit 0\n`)).toEqual({
			action: "skipped",
			reason: `found ${CORTEX_HOOK_BEGIN} without ${CORTEX_HOOK_END} — fix the markers and rerun`,
		});
	});
});

// An `exit` that is not the last statement is a branch this cannot read: the
// block might run, might not, and installing it would report success either
// way. Refusing says so.
describe("a hook that can leave before its end", () => {
	test("is refused rather than appended to", () => {
		const result = plan('#!/bin/sh\nexit 0\n\necho "unreachable"\n');
		expect(result).toEqual({
			action: "skipped",
			reason:
				"the existing hook runs `exit 0` before its end — the block would " +
				"never run there, so add it yourself",
		});
	});

	test("leaves an already-installed block where its author put it", () => {
		const installed = written('#!/bin/sh\necho "mine"\n');
		const branching = `${installed}\nif [ -n "$SKIP" ]; then\nexit 0\nfi\necho "after"\n`;
		expect(plan(branching, FROM_SOURCE).action).toBe("updated");
	});

	test("an indented exit inside a branch is not a terminator", () => {
		expect(
			plan('#!/bin/sh\nif [ -n "$SKIP" ]; then\n  exit 0\nfi\n').action,
		).toBe("appended");
	});
});

describe("planHookRemoval", () => {
	test("a missing hook has nothing to remove", () => {
		expect(planHookRemoval(null)).toEqual({ action: "absent" });
	});

	test("a hook cortex never touched has nothing to remove", () => {
		expect(planHookRemoval('#!/bin/sh\necho "mine"\n')).toEqual({
			action: "absent",
		});
	});

	test("a hook cortex created is left with nothing but its shebang", () => {
		const result = planHookRemoval(written(null));
		expect(result).toMatchObject({ action: "removed", leavesFileEmpty: true });
	});

	test("a hook the user owns keeps their lines", () => {
		const mine = '#!/bin/sh\necho "mine"\n';
		expect(planHookRemoval(written(mine))).toEqual({
			action: "removed",
			content: mine,
			leavesFileEmpty: false,
		});
	});

	test("refuses a half-written block", () => {
		expect(planHookRemoval(`${CORTEX_HOOK_BEGIN}\nhalf\n`)).toMatchObject({
			action: "skipped",
		});
	});
});

describe("hookEventActs", () => {
	test("post-checkout acts only on a branch checkout", () => {
		expect(hookEventActs("post-checkout", ["old", "new", "1"])).toBe(true);
		expect(hookEventActs("post-checkout", ["old", "new", "0"])).toBe(false);
		expect(hookEventActs("post-checkout", [])).toBe(false);
	});

	test("commit and merge always act", () => {
		expect(hookEventActs("post-commit", [])).toBe(true);
		expect(hookEventActs("post-merge", ["0"])).toBe(true);
	});
});

describe("parseHookEvent", () => {
	test("accepts the three installed events", () => {
		expect(parseHookEvent("post-commit")).toBe("post-commit");
		expect(parseHookEvent("post-checkout")).toBe("post-checkout");
		expect(parseHookEvent("post-merge")).toBe("post-merge");
	});

	test("rejects anything else", () => {
		expect(parseHookEvent("pre-commit")).toBeNull();
		expect(parseHookEvent(undefined)).toBeNull();
	});
});
