import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeAtomicallySync } from "@/support/atomic-write";
import { userCortexDir } from "@/support/cortex-home";
import { parseJsonOrNull } from "@/support/json";
import { ProjectRoot } from "./project-root";

export interface RegisteredProject {
	root: string;
	canonicalId: string;
	registeredAt: string;
}

interface RegistryEntry {
	root: string;
	canonical_id: string;
	registered_at: string;
}

interface RegistryFile {
	version: number;
	projects: RegistryEntry[];
}

const REGISTRY_VERSION = 1;

export function projectsRegistryPath(): string {
	return userCortexDir("projects.json", process.env.CORTEX_PROJECTS_FILE);
}

// A rebuildable per-user cache, like everything else under ~/.cortex: a
// corrupt file reads as empty, and entries whose store disappeared are pruned
// on read. Registration is best-effort on purpose — failing to record a
// project must never fail the init or the search that triggered it.
export function registerProject(root: string, canonicalId: string): void {
	try {
		const resolved = resolve(root);
		const entries = readEntries();
		if (entries.some((entry) => entry.root === resolved)) return;
		writeEntries([...entries, newEntry(resolved, canonicalId)]);
	} catch {}
}

export function readRegisteredProjects(): RegisteredProject[] {
	const entries = readEntries();
	const alive = entries.filter((entry) =>
		ProjectRoot.at(entry.root).isInitialized(),
	);
	if (alive.length !== entries.length) pruneTo(alive);
	return alive.map(toProject);
}

function newEntry(root: string, canonicalId: string): RegistryEntry {
	return {
		root,
		canonical_id: canonicalId,
		registered_at: new Date().toISOString(),
	};
}

function readEntries(): RegistryEntry[] {
	const text = readOrNull(projectsRegistryPath());
	if (text === null) return [];
	const parsed = parseJsonOrNull<RegistryFile>(text);
	if (!parsed || !Array.isArray(parsed.projects)) return [];
	return parsed.projects.filter(isEntry);
}

function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function pruneTo(entries: RegistryEntry[]): void {
	try {
		writeEntries(entries);
	} catch {}
}

function writeEntries(entries: RegistryEntry[]): void {
	const path = projectsRegistryPath();
	mkdirSync(dirname(path), { recursive: true });
	const file: RegistryFile = { version: REGISTRY_VERSION, projects: entries };
	writeAtomicallySync(path, `${JSON.stringify(file, null, "\t")}\n`);
}

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
