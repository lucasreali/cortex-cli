import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Git's sequencer keeps the steps it has not run yet in a todo file: a rebase
// on the merge backend (the default since 2.26) in rebase-merge/git-rebase-todo,
// `git cherry-pick A..B` and `git revert` in sequencer/todo. Measured on git
// 2.53: post-commit runs once per replayed commit and the file is already
// rewritten by then, so an empty todo is how the last commit of a replay
// announces itself.
const TODO_FILES = ["rebase-merge/git-rebase-todo", "sequencer/todo"];

// Answers null-safely like everything else in this directory: a repository this
// cannot read is one with no replay running, which is the answer that keeps the
// caller doing what it did before this guard existed.
export function replayStepsRemaining(cwd: string): boolean {
	const gitDirectory = nearestGitDirectory(resolve(cwd));
	if (!gitDirectory) return false;
	return TODO_FILES.some((file) => hasStep(join(gitDirectory, file)));
}

function nearestGitDirectory(directory: string): string | null {
	const gitPath = join(directory, ".git");
	const found = statSync(gitPath, { throwIfNoEntry: false });
	if (found?.isDirectory()) return gitPath;
	if (found) return linkedGitDirectory(directory, gitPath);
	const parent = dirname(directory);
	if (parent === directory) return null;
	return nearestGitDirectory(parent);
}

// A linked worktree and a submodule replace .git with a file naming the real
// directory, and each of them runs its own rebase there — reading the
// superproject's state would answer for an operation this checkout is not in.
function linkedGitDirectory(directory: string, gitPath: string): string | null {
	const pointer = readTextOrNull(gitPath)?.match(/^gitdir:\s*(.+)$/m)?.[1];
	if (!pointer) return null;
	return resolve(directory, pointer.trim());
}

function hasStep(todoPath: string): boolean {
	const todo = readTextOrNull(todoPath);
	if (todo === null) return false;
	return todo.split("\n").some(isStep);
}

function isStep(line: string): boolean {
	const step = line.trim();
	return step !== "" && !step.startsWith("#");
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
