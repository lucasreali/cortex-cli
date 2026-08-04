import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomically } from "@/support/atomic-write";
import { parseJsonOrNull } from "@/support/json";

export type WriteAction =
	| "created"
	| "updated"
	| "unchanged"
	| "skipped-unreadable";

export interface UpsertOutcome {
	path: string;
	action: WriteAction;
}

// Harness config files are shared surfaces: sibling MCP servers and unrelated
// keys must survive, a file we cannot parse must not be rewritten, and an
// entry that is already correct must not churn the file's formatting.
export async function upsertJsonMcpServer(
	filePath: string,
	entry: Record<string, unknown>,
): Promise<UpsertOutcome> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		mkdirSync(dirname(filePath), { recursive: true });
		await writeAtomically(filePath, render({ mcpServers: { cortex: entry } }));
		return { path: filePath, action: "created" };
	}
	const config = parseConfig(await file.text());
	if (!config) return { path: filePath, action: "skipped-unreadable" };
	if (Bun.deepEquals(config.servers.cortex, entry, true)) {
		return { path: filePath, action: "unchanged" };
	}
	const next = {
		...config.root,
		mcpServers: { ...config.servers, cortex: entry },
	};
	await writeAtomically(filePath, render(next));
	return { path: filePath, action: "updated" };
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
