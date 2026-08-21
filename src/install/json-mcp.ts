import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomicallyIfUnchanged } from "@/support/atomic-write";
import { parseJsonOrNull } from "@/support/json";

export type UpsertOutcome =
	| { path: string; action: "created" | "updated" | "unchanged" }
	| { path: string; action: "skipped"; reason: string };

// The file is read, merged and written by this module, so the write is where
// its boundary sits: everything above it is a decision about content, and the
// caller supplies the one call that touches the disk.
export type GuardedWrite = (
	path: string,
	content: string,
	expected: string | null,
) => Promise<boolean>;

const UNREADABLE = "is not valid JSON — fix or remove it, then rerun";
const CONTESTED = "is being rewritten by another process — rerun";

// Three is enough for a neighbour that writes on its own schedule and too few
// to spin in front of a person: each attempt re-reads, so a lost race merges
// onto what the other writer left rather than onto what we read first.
const ATTEMPTS = 3;

// Harness config files are shared surfaces: sibling MCP servers and unrelated
// keys must survive, a file we cannot parse must not be rewritten, and an
// entry that is already correct must not churn the file's formatting.
export async function upsertJsonMcpServer(
	filePath: string,
	entry: Record<string, unknown>,
	write: GuardedWrite = writeAtomicallyIfUnchanged,
): Promise<UpsertOutcome> {
	for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
		const outcome = await attemptUpsert(filePath, entry, write);
		if (outcome) return outcome;
	}
	return { path: filePath, action: "skipped", reason: CONTESTED };
}

async function attemptUpsert(
	filePath: string,
	entry: Record<string, unknown>,
	write: GuardedWrite,
): Promise<UpsertOutcome | null> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return create(filePath, entry, write);
	const text = await file.text();
	const config = parseConfig(text);
	if (!config) return { path: filePath, action: "skipped", reason: UNREADABLE };
	const cortex = merged(config.servers.cortex, entry);
	if (Bun.deepEquals(config.servers.cortex, cortex, true)) {
		return { path: filePath, action: "unchanged" };
	}
	const next = { ...config.root, mcpServers: { ...config.servers, cortex } };
	const written = await write(filePath, render(next), text);
	return written ? { path: filePath, action: "updated" } : null;
}

async function create(
	filePath: string,
	entry: Record<string, unknown>,
	write: GuardedWrite,
): Promise<UpsertOutcome | null> {
	mkdirSync(dirname(filePath), { recursive: true });
	const content = render({ mcpServers: { cortex: entry } });
	const written = await write(filePath, content, null);
	return written ? { path: filePath, action: "created" } : null;
}

// The entry we render is the whole server definition, but it is not the whole
// entry: a user who added `env` to the cortex server is suppressing behaviour,
// and replacing the entry wholesale brings that behaviour back with no diff
// and no warning. Our keys win, everything else the user put there survives.
function merged(
	current: unknown,
	entry: Record<string, unknown>,
): Record<string, unknown> {
	return isRecord(current) ? { ...current, ...entry } : entry;
}

interface ParsedConfig {
	root: Record<string, unknown>;
	servers: Record<string, unknown>;
}

function parseConfig(text: string): ParsedConfig | null {
	const root = text.trim() === "" ? {} : parseJsonOrNull(text);
	if (!isRecord(root)) return null;
	const servers = root.mcpServers ?? {};
	if (!isRecord(servers)) return null;
	return { root, servers };
}

function render(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
