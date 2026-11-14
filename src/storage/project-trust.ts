import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeAtomicallySync } from "@/support/atomic-write";
import { userCortexDir } from "@/support/cortex-home";
import { parseJsonOrNull } from "@/support/json";

interface TrustFile {
	version: number;
	projects: string[];
}

const TRUST_VERSION = 1;

// Which repositories this user lets the prompt hook read from. Decision files
// arrive through any merged pull request, and the hook puts their text in
// front of the model on every matching prompt, on every repository the user
// opens — so a clone is not trusted until a person says so, the way direnv
// asks before running an .envrc it has not seen. `cortex init` and
// `cortex trust` are the two ways to say so; nothing on a read path ever adds
// an entry. No environment variable relocates it: anything able to set one —
// a cloned repository's .envrc — could otherwise hand the hook a list that
// trusts itself.
export function trustFilePath(): string {
	return userCortexDir("trusted-projects.json", undefined);
}

export function isTrustedProject(
	root: string,
	path = trustFilePath(),
): boolean {
	return readTrusted(path).includes(canonical(root));
}

// One spelling per directory: `git rev-parse` answers with the real path, a
// hook's cwd may arrive through a symlink (macOS's /var is one), and the two
// must name the same entry.
function canonical(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		return resolve(root);
	}
}

export function trustProject(root: string, path = trustFilePath()): boolean {
	const projects = readTrusted(path);
	const wanted = canonical(root);
	if (projects.includes(wanted)) return false;
	write(path, [...projects, wanted].sort());
	return true;
}

export function revokeProject(root: string, path = trustFilePath()): boolean {
	const projects = readTrusted(path);
	const unwanted = canonical(root);
	if (!projects.includes(unwanted)) return false;
	write(
		path,
		projects.filter((project) => project !== unwanted),
	);
	return true;
}

// An unreadable file trusts nothing: the failure mode of a trust list has to
// be the one where the hook stays quiet.
function readTrusted(path: string): string[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const parsed = parseJsonOrNull<Partial<TrustFile>>(raw);
	if (!Array.isArray(parsed?.projects)) return [];
	return parsed.projects.filter(
		(project): project is string => typeof project === "string",
	);
}

function write(path: string, projects: string[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const file: TrustFile = { version: TRUST_VERSION, projects };
	writeAtomicallySync(path, `${JSON.stringify(file, null, 2)}\n`);
}
