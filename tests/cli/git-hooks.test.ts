import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORTEX_HOOK_BEGIN, CORTEX_HOOK_END } from "@/install/git-hooks";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const EVENTS = ["post-commit", "post-checkout", "post-merge"];
const MINE = '#!/bin/sh\necho "mine"\n';

let dir: string;
let home: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-hooks-")));
	home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-hooks-home-")));
	git("init", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "commit.gpgsign", "false");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

function cli(...args: string[]) {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: home },
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

// The hooks inherit this environment, so disabling embeddings here is what
// keeps a commit in the test suite from loading the real model.
function git(...args: string[]) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: home },
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function hookPath(event: string): string {
	return join(dir, ".git", "hooks", event);
}

function readHook(event: string): string {
	return readFileSync(hookPath(event), "utf8");
}

describe("cortex install --git-hooks", () => {
	test("installs an executable, marker-fenced block for each event", () => {
		const result = cli("install", "--git-hooks", "--yes");
		expect(result.code).toBe(0);
		for (const event of EVENTS) {
			const content = readHook(event);
			expect(content).toStartWith("#!/bin/sh\n");
			expect(content).toContain(CORTEX_HOOK_BEGIN);
			expect(content).toContain(CORTEX_HOOK_END);
			expect(content).toContain(`git-hook ${event} "$@"`);
			expect(content).toContain(MAIN_PATH);
			expect(statSync(hookPath(event)).mode & 0o111).toBeGreaterThan(0);
		}
	});

	test("preserves a hook the user wrote, and its mode", () => {
		writeFileSync(hookPath("post-commit"), MINE);
		chmodSync(hookPath("post-commit"), 0o755);

		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(readHook("post-commit")).toStartWith(MINE);
		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(statSync(hookPath("post-commit")).mode & 0o111).toBeGreaterThan(0);
	});

	// L7: the install chmodded 0755 unconditionally, publishing a hook its
	// author had deliberately kept to themselves.
	test("does not widen a hook the user kept private", () => {
		writeFileSync(hookPath("post-commit"), MINE);
		chmodSync(hookPath("post-commit"), 0o700);

		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(statSync(hookPath("post-commit")).mode & 0o777).toBe(0o700);
	});

	test("makes a hook git could not execute executable again", () => {
		writeFileSync(hookPath("post-commit"), MINE);
		chmodSync(hookPath("post-commit"), 0o640);

		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(statSync(hookPath("post-commit")).mode & 0o777).toBe(0o750);
	});

	// M36: the block used to go below the `exit 0`, where the shell never
	// arrives, and the install still printed three green lines.
	test("puts the block above a generated hook's trailing exit 0", () => {
		writeFileSync(hookPath("post-commit"), `${MINE}exit 0\n`);

		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		const content = readHook("post-commit");
		expect(content.indexOf(CORTEX_HOOK_END)).toBeLessThan(
			content.lastIndexOf("\nexit 0\n"),
		);
		expect(content).toEndWith("exit 0\n");
	});

	test("a second install is idempotent, byte for byte", () => {
		cli("install", "--git-hooks", "--yes");
		const first = readHook("post-commit");
		const second = cli("install", "--git-hooks", "--yes");
		expect(second.stdout).toContain("already installed");
		expect(readHook("post-commit")).toBe(first);
	});

	test("uninstall removes only the marked block", () => {
		writeFileSync(hookPath("post-commit"), MINE);
		cli("install", "--git-hooks", "--yes");

		const result = cli("install", "--git-hooks", "--uninstall", "--yes");
		expect(result.code).toBe(0);
		expect(readHook("post-commit")).toBe(MINE);
		// The hooks cortex created outright go away entirely.
		expect(existsSync(hookPath("post-checkout"))).toBe(false);
		expect(existsSync(hookPath("post-merge"))).toBe(false);
	});

	test("uninstalling twice is not an error", () => {
		cli("install", "--git-hooks", "--yes");
		cli("install", "--git-hooks", "--uninstall", "--yes");
		const again = cli("install", "--git-hooks", "--uninstall", "--yes");
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("Nothing to remove");
	});

	test("refuses a hook written in another language", () => {
		const python = "#!/usr/bin/env python3\nprint(1)\n";
		writeFileSync(hookPath("post-commit"), python);
		const result = cli("install", "--git-hooks", "--yes");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("python3 script");
		expect(readHook("post-commit")).toBe(python);
	});

	test("leaves a symlinked hook alone", () => {
		const shared = join(dir, "shared-hook.sh");
		writeFileSync(shared, MINE);
		symlinkSync(shared, hookPath("post-commit"));
		const result = cli("install", "--git-hooks", "--yes");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("symlink");
		expect(readFileSync(shared, "utf8")).toBe(MINE);
	});

	test("needs a git repository", () => {
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-")));
		try {
			const result = Bun.spawnSync(
				["bun", MAIN_PATH, "install", "--git-hooks", "--yes"],
				{ cwd: bare, stdout: "pipe", stderr: "pipe", env: { ...process.env } },
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr.toString()).toContain("git repository");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test("writes nothing without --yes when there is no terminal", () => {
		const result = cli("install", "--git-hooks");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("nothing written");
		expect(existsSync(hookPath("post-commit"))).toBe(false);
	});

	test("--uninstall alone is a usage error", () => {
		const result = cli("install", "--uninstall", "--yes");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--uninstall only applies to --git-hooks");
	});

	// Registering the MCP server is user-scoped; hooks are repo-scoped. Asking
	// for one must never do the other.
	test("does not register the MCP server", () => {
		mkdirSync(join(home, ".claude"));
		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(existsSync(join(home, ".claude.json"))).toBe(false);
	});

	test("a plain install leaves the hooks directory alone", () => {
		mkdirSync(join(home, ".claude"));
		expect(cli("install", "--yes").code).toBe(0);
		expect(existsSync(hookPath("post-commit"))).toBe(false);
	});

	// M32: a config.toml that already defines the server in a shape the line
	// splice cannot rewrite used to get a second definition appended, which
	// stops the whole file parsing. It is named and left alone instead.
	test("names a codex config it refuses to rewrite, and exits 1", () => {
		const config = join(home, ".codex", "config.toml");
		mkdirSync(join(home, ".codex"));
		const existing = 'mcp_servers = { cortex = { command = "/old" } }\n';
		writeFileSync(config, existing);

		const result = cli("install", "--target", "codex", "--yes");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("mcp_servers.cortex");
		expect(readFileSync(config, "utf8")).toBe(existing);
	});
});

describe("the installed hooks reconcile without an explicit command", () => {
	function decisionFile(id: string, title: string): void {
		mkdirSync(join(dir, ".cortex", "decisions"), { recursive: true });
		writeFileSync(
			join(dir, ".cortex", "decisions", `${id}.md`),
			[
				"---",
				`title: ${JSON.stringify(title)}`,
				'keywords: ["alpha", "beta", "gamma", "delta", "epsilon"]',
				'provenance: "agent"',
				'created_at: "2026-08-14T12:00:00.000Z"',
				"---",
				"",
				`${title} body.`,
				"",
			].join("\n"),
		);
	}

	function commitAll(message: string) {
		git("add", "-A");
		return git("commit", "-m", message);
	}

	function presenceOf(id: string): number | null {
		const db = new Database(join(dir, ".cortex", "decisions.db"), {
			readonly: true,
		});
		try {
			return (
				db
					.query<{ present: number }, [string]>(
						"SELECT present FROM nodes WHERE id = ?",
					)
					.get(id)?.present ?? null
			);
		} finally {
			db.close();
		}
	}

	const ON_MAIN = "019f0000-0000-7000-8000-0000000000a1";
	const ON_FEATURE = "019f0000-0000-7000-8000-0000000000b2";

	function repoWithHooks(): void {
		expect(cli("init", "--yes").code).toBe(0);
		decisionFile(ON_MAIN, "Main decision");
		expect(cli("install", "--git-hooks", "--yes").code).toBe(0);
		expect(commitAll("main decision").code).toBe(0);
	}

	// From here on nothing calls cortex: every reconcile below is a git hook.
	test("a branch switch flips present, and switching back restores it", () => {
		repoWithHooks();
		git("checkout", "-b", "feature");
		decisionFile(ON_FEATURE, "Feature decision");
		expect(commitAll("feature decision").code).toBe(0);
		expect(presenceOf(ON_FEATURE)).toBe(1);

		git("checkout", "main");
		expect(presenceOf(ON_FEATURE)).toBe(0);
		expect(presenceOf(ON_MAIN)).toBe(1);

		git("checkout", "feature");
		expect(presenceOf(ON_FEATURE)).toBe(1);
	});

	// A fast-forwarding pull fires neither post-commit nor post-checkout.
	test("a merge imports the decisions it brings", () => {
		repoWithHooks();
		git("checkout", "-b", "feature");
		decisionFile(ON_FEATURE, "Feature decision");
		commitAll("feature decision");
		git("checkout", "main");
		expect(presenceOf(ON_FEATURE)).toBe(0);

		expect(git("merge", "--no-ff", "-m", "merge", "feature").code).toBe(0);
		expect(presenceOf(ON_FEATURE)).toBe(1);
	});

	test("the kill-switch stops the hook without stopping the commit", () => {
		repoWithHooks();
		git("checkout", "-b", "feature");
		decisionFile(ON_FEATURE, "Feature decision");
		git("add", "-A");
		const result = Bun.spawnSync(["git", "commit", "-m", "feature"], {
			cwd: dir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: home, CORTEX_NO_GIT_HOOK: "1" },
		});
		expect(result.exitCode).toBe(0);
		expect(presenceOf(ON_FEATURE)).toBeNull();
	});

	// A hook that waited out the lock would hold up the commit; one that gave
	// up silently would lose the decision until the next command happened to
	// run. It hands the reconcile to a detached child instead.
	test("a busy store defers the reconcile instead of dropping it", async () => {
		repoWithHooks();
		git("checkout", "-b", "feature");
		decisionFile(ON_FEATURE, "Feature decision");
		const writer = new Database(join(dir, ".cortex", "decisions.db"));
		try {
			writer.run("PRAGMA busy_timeout = 5000;");
			writer.run("BEGIN IMMEDIATE;");
			expect(commitAll("feature decision").code).toBe(0);
			expect(presenceOf(ON_FEATURE)).toBeNull();
		} finally {
			writer.run("ROLLBACK;");
			writer.close();
		}
		expect(await eventually(() => presenceOf(ON_FEATURE) === 1)).toBe(true);
	}, 20_000);

	async function eventually(settled: () => boolean): Promise<boolean> {
		for (let attempt = 0; attempt < 150; attempt++) {
			if (settled()) return true;
			await Bun.sleep(100);
		}
		return false;
	}

	test("a corrupt store never fails the commit", () => {
		repoWithHooks();
		writeFileSync(join(dir, ".cortex", "decisions.db"), "not a database");
		decisionFile(ON_FEATURE, "Feature decision");
		const result = commitAll("feature decision");
		expect(result.code).toBe(0);
		expect(git("log", "--oneline").stdout).toContain("feature decision");
	});

	test("a repository without a store keeps not having one", () => {
		cli("install", "--git-hooks", "--yes");
		writeFileSync(join(dir, "README.md"), "# hi\n");
		expect(commitAll("readme").code).toBe(0);
		expect(existsSync(join(dir, ".cortex"))).toBe(false);
	});
});
