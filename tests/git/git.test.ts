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
import { getCanonicalProjectId, getHead, getRepoRoot } from "../../src/git";

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
