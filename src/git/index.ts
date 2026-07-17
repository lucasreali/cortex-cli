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

export function getHead(cwd: string): HeadState | null {
	const sha = runGit(cwd, ["rev-parse", "HEAD"]);
	if (!sha) return null;
	const status = runGit(cwd, ["status", "--porcelain"]);
	return { sha, dirty: status !== null && status.length > 0 };
}

function runGit(cwd: string, args: string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	if (result.exitCode !== 0) return null;
	return result.stdout.toString().trim();
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
