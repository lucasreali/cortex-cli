import { resolve } from "node:path";

export interface HeadState {
	sha: string;
	dirty: boolean;
}

export function getRepoRoot(cwd: string): string | null {
	return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export function getCanonicalProjectId(cwd: string): string | null {
	const root = getRepoRoot(cwd);
	if (!root) return null;
	const remoteUrl = runGit(cwd, ["remote", "get-url", "origin"]);
	// Without a remote (or with an unparseable one) there is no canonical
	// host/user/repo identity, so the absolute repo root stands in for it —
	// stable locally, at the cost of differing between machines.
	if (!remoteUrl) return root;
	return parseRemoteUrl(remoteUrl) ?? root;
}

export function listRepoFiles(cwd: string): string[] | null {
	const output = runGit(cwd, [
		"-c",
		"core.quotepath=off",
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
	]);
	if (output === null) return null;
	return output.split("\n").filter((line) => line.length > 0);
}

// git is the only thing that knows where hooks live: core.hooksPath, husky and
// linked worktrees all move the directory. Its answer is relative to cwd
// (`../.git/hooks` from a subdirectory), so it is resolved against cwd rather
// than asked for with --path-format=absolute, which older git echoes back as a
// literal argument instead of honoring.
export function getHooksPath(cwd: string): string | null {
	const path = runGit(cwd, ["rev-parse", "--git-path", "hooks"]);
	if (!path) return null;
	return resolve(cwd, path);
}

export function getHead(cwd: string): HeadState | null {
	const sha = runGit(cwd, ["rev-parse", "HEAD"]);
	if (!sha) return null;
	const status = runGit(cwd, ["status", "--porcelain"]);
	return { sha, dirty: status !== null && status.length > 0 };
}

// Every accessor here answers `null` outside a repo, and `Bun.spawnSync` puts
// two ways of being outside one past the exit code: no `git` on PATH and a cwd
// that no longer exists both throw rather than returning a failed result. They
// are the exact cases the callers' fallbacks were written for, so they are
// answered like any other non-zero exit.
function runGit(cwd: string, args: string[]): string | null {
	const result = spawnGit(cwd, args);
	if (result === null || result.exitCode !== 0) return null;
	return result.stdout.toString().trim();
}

function spawnGit(
	cwd: string,
	args: string[],
): { exitCode: number; stdout: Buffer } | null {
	try {
		return Bun.spawnSync(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
		});
	} catch {
		return null;
	}
}

function parseRemoteUrl(url: string): string | null {
	return parseScpLikeUrl(url) ?? parseStandardUrl(url);
}

function parseScpLikeUrl(url: string): string | null {
	const match = url.match(/^[\w.-]+@([\w.-]+):(.+)$/);
	if (!match) return null;
	const [, host, path] = match;
	if (!host || !path) return null;
	return `${host}/${normalizePath(path)}`;
}

function parseStandardUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (!parsed.hostname) return null;
	return `${parsed.hostname}/${normalizePath(parsed.pathname)}`;
}

function normalizePath(path: string): string {
	return path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
}
