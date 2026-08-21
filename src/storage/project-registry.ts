import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeAtomicallySync } from "@/support/atomic-write";
import { userCortexDir } from "@/support/cortex-home";
import { errorMessage } from "@/support/errors";
import { parseJsonOrNull } from "@/support/json";
import { ProjectRoot } from "./project-root";

export interface RegisteredProject {
	root: string;
	canonicalId: string;
	registeredAt: string;
}

export type ProjectRegistryRead =
	| { state: "ok"; projects: RegisteredProject[] }
	| { state: "missing" }
	| { state: "unreadable" };

interface RegistryEntry {
	root: string;
	canonical_id: string;
	registered_at: string;
}

interface RegistryFile {
	version: number;
	projects: RegistryEntry[];
}

type RegistryRead =
	| { state: "ok"; entries: RegistryEntry[] }
	| { state: "missing" }
	| { state: "unreadable" };

const REGISTRY_VERSION = 1;

let reportedCorruption = false;

export function projectsRegistryPath(): string {
	return userCortexDir("projects.json", process.env.CORTEX_PROJECTS_FILE);
}

// A rebuildable per-user cache, like everything else under ~/.cortex, and
// registration is best-effort on purpose — failing to record a project must
// never fail the init or the search that triggered it. What is not disposable
// is a file that is there but unreadable: reading it as empty and writing on
// top would drop every other project the user tracks, so it is renamed aside
// first, and left untouched when even that fails.
//
// This is also the only path that drops entries. Pruning here is what keeps
// reads from rewriting the file, and from rewriting it out of a snapshot the
// caller took before a concurrent `cortex init` appended to it.
export function registerProject(root: string, canonicalId: string): void {
	try {
		const resolved = resolve(root);
		const read = readRegistry();
		if (read.state === "unreadable" && !backUpCorruptRegistry()) return;
		const entries = read.state === "ok" ? read.entries : [];
		if (entries.some((entry) => entry.root === resolved)) return;
		const kept = entries.filter(
			(entry) => !ProjectRoot.at(entry.root).isProvablyAbsent(),
		);
		writeEntries([...kept, newEntry(resolved, canonicalId)]);
	} catch {}
}

// Filtered, never pruned: isInitialized is an existsSync, which is also false
// for EACCES or an unmounted volume, so a store behind an unreachable mount is
// absent from this one answer and comes back on the next.
export function readProjectRegistry(): ProjectRegistryRead {
	const read = readRegistry();
	if (read.state !== "ok") return read;
	const alive = read.entries
		.filter((entry) => ProjectRoot.at(entry.root).isInitialized())
		.map(toProject);
	return { state: "ok", projects: alive };
}

export function corruptRegistryBackups(): string[] {
	const path = projectsRegistryPath();
	const prefix = `${basename(path)}.corrupt.`;
	return readNames(dirname(path))
		.filter((name) => name.startsWith(prefix))
		.map((name) => join(dirname(path), name))
		.sort();
}

function backUpCorruptRegistry(): boolean {
	const path = projectsRegistryPath();
	const backup = `${path}.corrupt.${Date.now()}`;
	try {
		renameSync(path, backup);
		report(
			`project registry at ${path} is not valid JSON; moved to ${backup} ` +
				"and started fresh — restore it if this was unexpected.",
		);
		return true;
	} catch (error) {
		report(
			`project registry at ${path} is not valid JSON and could not be ` +
				`backed up (${errorMessage(error)}); leaving it untouched and not ` +
				"registering this project.",
		);
		return false;
	}
}

// Once per process: the MCP server registers a project per session, and the
// same broken file would otherwise be announced on every one of them.
function report(message: string): void {
	if (reportedCorruption) return;
	reportedCorruption = true;
	console.error(`[cortex] ${message}`);
}

function newEntry(root: string, canonicalId: string): RegistryEntry {
	return {
		root,
		canonical_id: canonicalId,
		registered_at: new Date().toISOString(),
	};
}

function readRegistry(): RegistryRead {
	const path = projectsRegistryPath();
	const text = readOrNull(path);
	if (text === null) {
		return existsSync(path) ? { state: "unreadable" } : { state: "missing" };
	}
	const parsed = parseJsonOrNull<RegistryFile>(text);
	if (!parsed || !Array.isArray(parsed.projects))
		return { state: "unreadable" };
	return { state: "ok", entries: parsed.projects.filter(isEntry) };
}

function readNames(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function writeEntries(entries: RegistryEntry[]): void {
	const path = projectsRegistryPath();
	mkdirSync(dirname(path), { recursive: true });
	const file: RegistryFile = { version: REGISTRY_VERSION, projects: entries };
	writeAtomicallySync(path, `${JSON.stringify(file, null, "\t")}\n`);
}

// A single malformed entry is dropped rather than condemning the file: the
// entries around it are still every project the user tracks. Corruption is a
// fact about the whole file, never about one of its rows.
function isEntry(value: unknown): value is RegistryEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Partial<RegistryEntry>;
	return (
		typeof entry.root === "string" &&
		typeof entry.canonical_id === "string" &&
		typeof entry.registered_at === "string"
	);
}

function toProject(entry: RegistryEntry): RegisteredProject {
	return {
		root: entry.root,
		canonicalId: entry.canonical_id,
		registeredAt: entry.registered_at,
	};
}
