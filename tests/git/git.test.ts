import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getCanonicalProjectId,
	getHead,
	getHooksPath,
	getRepoRoot,
	listRepoFiles,
} from "@/git";

let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-git-")));
	run("git", "init", "-b", "main");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(...command: string[]): void {
	const result = Bun.spawnSync(command, {
		cwd: dir,
		stdout: "ignore",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	}
}

function commitFile(name: string, content: string): void {
	writeFileSync(join(dir, name), content);
	run("git", "add", name);
	run(
		"git",
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test",
		"commit",
		"-m",
		"commit",
		"--no-gpg-sign",
	);
}

describe("getRepoRoot", () => {
	test("returns the repository root from a nested directory", () => {
		const nested = join(dir, "src", "auth");
		mkdirSync(nested, { recursive: true });
		expect(getRepoRoot(nested)).toBe(dir);
	});

	test("returns null outside a repository", () => {
		const outside = mkdtempSync(join(tmpdir(), "cortex-no-git-"));
		try {
			expect(getRepoRoot(outside)).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	// Bun.spawnSync throws rather than returning a failed result when the cwd
	// is gone, and every caller here documents that it answers null instead.
	test("returns null when the working directory no longer exists", () => {
		const vanished = mkdtempSync(join(tmpdir(), "cortex-gone-"));
		rmSync(vanished, { recursive: true, force: true });

		expect(getRepoRoot(vanished)).toBeNull();
		expect(getHooksPath(vanished)).toBeNull();
		expect(getHead(vanished)).toBeNull();
		expect(getCanonicalProjectId(vanished)).toBeNull();
		expect(listRepoFiles(vanished)).toBeNull();
	});

	// The same throw, from the other end: a PATH without git used to kill
	// `cortex log` with `Executable not found in $PATH: "git"`. It has to be a
	// subprocess — the lookup does not read a PATH this process reassigns.
	test("returns null when git is not on PATH", () => {
		const probe = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				'import { getRepoRoot, getHead } from "@/git";' +
					"console.log(JSON.stringify([getRepoRoot(process.cwd()), getHead(process.cwd())]));",
			],
			{
				cwd: process.cwd(),
				env: { PATH: join(tmpdir(), "cortex-path-that-is-not-there") },
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		expect(probe.stderr.toString()).toBe("");
		expect(probe.stdout.toString().trim()).toBe("[null,null]");
	});
});

describe("getHooksPath", () => {
	test("is absolute, and the same from a nested directory", () => {
		const nested = join(dir, "src", "auth");
		mkdirSync(nested, { recursive: true });
		expect(getHooksPath(dir)).toBe(join(dir, ".git", "hooks"));
		expect(getHooksPath(nested)).toBe(join(dir, ".git", "hooks"));
	});

	test("follows a relative core.hooksPath", () => {
		run("git", "config", "core.hooksPath", ".husky");
		expect(getHooksPath(dir)).toBe(join(dir, ".husky"));
	});

	test("follows an absolute core.hooksPath", () => {
		run("git", "config", "core.hooksPath", "/opt/shared-hooks");
		expect(getHooksPath(dir)).toBe("/opt/shared-hooks");
	});

	test("returns null outside a repository", () => {
		const outside = mkdtempSync(join(tmpdir(), "cortex-no-git-"));
		try {
			expect(getHooksPath(outside)).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("getCanonicalProjectId", () => {
	test("parses an SSH remote into host/user/repo", () => {
		run("git", "remote", "add", "origin", "git@github.com:acme/cortex.git");
		expect(getCanonicalProjectId(dir)).toBe("github.com/acme/cortex");
	});

	test("parses an HTTPS remote into host/user/repo", () => {
		run("git", "remote", "add", "origin", "https://github.com/acme/cortex.git");
		expect(getCanonicalProjectId(dir)).toBe("github.com/acme/cortex");
	});

	test("parses an ssh:// remote with credentials", () => {
		run(
			"git",
			"remote",
			"add",
			"origin",
			"ssh://git@gitlab.com/group/subgroup/repo.git",
		);
		expect(getCanonicalProjectId(dir)).toBe("gitlab.com/group/subgroup/repo");
	});

	test("falls back to the absolute repo root without a remote", () => {
		expect(getCanonicalProjectId(dir)).toBe(dir);
	});

	test("falls back to the repo root for hostless remote URLs", () => {
		run("git", "remote", "add", "origin", "file:///srv/repos/demo.git");
		expect(getCanonicalProjectId(dir)).toBe(dir);
	});

	test("falls back to the repo root for unparseable remotes", () => {
		run("git", "remote", "add", "origin", "../relative/other-repo");
		expect(getCanonicalProjectId(dir)).toBe(dir);
	});

	test("returns null outside a repository", () => {
		const outside = mkdtempSync(join(tmpdir(), "cortex-no-git-"));
		try {
			expect(getCanonicalProjectId(outside)).toBeNull();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("getHead", () => {
	test("returns null before the first commit", () => {
		expect(getHead(dir)).toBeNull();
	});

	test("reports a clean worktree", () => {
		commitFile("a.txt", "first\n");
		const head = getHead(dir);
		expect(head?.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(head?.dirty).toBe(false);
	});

	test("reports dirty on modified tracked files", () => {
		commitFile("a.txt", "first\n");
		writeFileSync(join(dir, "a.txt"), "changed\n");
		expect(getHead(dir)?.dirty).toBe(true);
	});

	test("reports dirty on untracked files", () => {
		commitFile("a.txt", "first\n");
		writeFileSync(join(dir, "b.txt"), "new\n");
		expect(getHead(dir)?.dirty).toBe(true);
	});
});
