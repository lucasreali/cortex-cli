import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replayStepsRemaining } from "@/git/replay";

const REPLAY_MODULE = new URL("../../src/git/replay.ts", import.meta.url)
	.pathname;

let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-replay-")));
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
		env: { ...process.env, GIT_SEQUENCE_EDITOR: ":", GIT_EDITOR: ":" },
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
		name,
		"--no-gpg-sign",
	);
}

function writeTodo(relativePath: string, contents: string): void {
	const path = join(dir, ".git", relativePath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

describe("replayStepsRemaining", () => {
	test("is false in a repository running nothing", () => {
		commitFile("a.txt", "a");
		expect(replayStepsRemaining(dir)).toBe(false);
	});

	test("is false outside a repository", () => {
		const outside = realpathSync(mkdtempSync(join(tmpdir(), "cortex-bare-")));
		try {
			expect(replayStepsRemaining(outside)).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("sees a rebase from a nested working directory", () => {
		writeTodo("rebase-merge/git-rebase-todo", "pick 1a2b3c4 second\n");
		const nested = join(dir, "src", "auth");
		mkdirSync(nested, { recursive: true });
		expect(replayStepsRemaining(nested)).toBe(true);
	});

	test("sees a cherry-pick or a revert through the sequencer", () => {
		writeTodo("sequencer/todo", "pick 1a2b3c4 second\n");
		expect(replayStepsRemaining(dir)).toBe(true);
	});

	// The last replayed commit is the one that must embed, and git tells it so
	// by leaving nothing but the instruction block behind.
	test("is false once only blank lines and comments remain", () => {
		writeTodo(
			"rebase-merge/git-rebase-todo",
			"\n# Rebase 1a2b3c4..5d6e7f8 onto 1a2b3c4 (1 command)\n#\n# p, pick\n",
		);
		expect(replayStepsRemaining(dir)).toBe(false);
	});

	test("reads the state of a linked worktree, not of the repository", () => {
		commitFile("a.txt", "a");
		const linked = join(dir, "..", "cortex-replay-linked");
		run("git", "worktree", "add", "-b", "side", linked);
		try {
			writeTodo("rebase-merge/git-rebase-todo", "pick 1a2b3c4 second\n");
			expect(replayStepsRemaining(linked)).toBe(false);

			const pointer = readFileSync(join(linked, ".git"), "utf8");
			const worktreeGitDir = pointer.replace("gitdir:", "").trim();
			mkdirSync(join(worktreeGitDir, "rebase-merge"), { recursive: true });
			writeFileSync(
				join(worktreeGitDir, "rebase-merge", "git-rebase-todo"),
				"pick 1a2b3c4 second\n",
			);
			expect(replayStepsRemaining(linked)).toBe(true);
		} finally {
			rmSync(linked, { recursive: true, force: true });
		}
	});

	test("is false when the pointer file names nothing", () => {
		const orphan = realpathSync(mkdtempSync(join(tmpdir(), "cortex-orphan-")));
		try {
			writeFileSync(join(orphan, ".git"), "not a pointer\n");
			expect(replayStepsRemaining(orphan)).toBe(false);
		} finally {
			rmSync(orphan, { recursive: true, force: true });
		}
	});
});

// The measurement the whole guard rests on: git rewrites the todo before it
// runs post-commit, so the answer is true for every replayed commit but the
// last. It is pinned end to end because a git that stopped doing that would
// otherwise silently bring back one model load per replayed commit.
describe("a real rebase", () => {
	test("reports steps remaining until the last replayed commit", () => {
		const log = join(dir, "replay.log");
		const hook = join(dir, ".git", "hooks", "post-commit");
		writeFileSync(
			hook,
			[
				"#!/bin/sh",
				`bun -e "import { replayStepsRemaining } from '${REPLAY_MODULE}';` +
					` console.log(replayStepsRemaining(process.cwd()))" >> "${log}"`,
				"",
			].join("\n"),
		);
		chmodSync(hook, 0o755);

		commitFile("base.txt", "base");
		run("git", "checkout", "-q", "-b", "feature");
		commitFile("one.txt", "one");
		commitFile("two.txt", "two");
		commitFile("three.txt", "three");
		run("git", "checkout", "-q", "main");
		commitFile("other.txt", "other");
		run("git", "checkout", "-q", "feature");
		writeFileSync(log, "");

		run("git", "rebase", "main");

		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"true",
			"true",
			"false",
		]);
	});
});
