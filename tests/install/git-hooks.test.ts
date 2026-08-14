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
