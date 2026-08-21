import type { McpServerSpec } from "./server-spec";

const SERVERS_KEY = "mcp_servers";
const CORTEX_KEY = "cortex";
const CORTEX_TABLE_PATH = [SERVERS_KEY, CORTEX_KEY];

export const CORTEX_TABLE_HEADER = `[${CORTEX_TABLE_PATH.join(".")}]`;

export type TomlUpsert =
	| { content: string; action: "inserted" | "replaced" | "unchanged" }
	| { action: "conflict"; reason: string };

type Table = Record<string, unknown>;

const UNPARSEABLE = "is not valid TOML — fix or remove it, then rerun";
const UNSPLICEABLE =
	`already defines ${CORTEX_TABLE_PATH.join(".")} in a shape cortex cannot ` +
	"rewrite — edit the entry yourself";

// A surgical line splice instead of a parse-and-serialize round trip: only the
// cortex table is ever rewritten, so the rest of the user's config survives
// byte-for-byte, comments and formatting included.
//
// The parser is here for judgement, not for rendering. `[ mcp_servers.cortex ]`,
// `[mcp_servers."cortex"]` and an inline `mcp_servers = { cortex = … }` all
// define the table that a whole-line search misses, and TOML forbids defining
// one twice: appending a second definition does not add a server, it stops the
// whole file parsing — every other MCP server in it included. So the parser
// decides whether the table is already there, the line search only guesses
// where, and the spliced result is parsed back and compared before it is
// returned. A guess that was wrong costs a refusal, never the user's config.
export function upsertTomlTable(
	content: string,
	spec: McpServerSpec,
): TomlUpsert {
	const parsed = parseOrNull(content);
	if (!parsed) return { action: "conflict", reason: UNPARSEABLE };
	const current = cortexEntry(parsed);
	const next = { ...current, command: spec.command, args: [...spec.args] };
	if (current && Bun.deepEquals(current, next, true)) {
		return { content, action: "unchanged" };
	}
	const spliced = splice(content, renderCortexTable(next), current !== null);
	if (spliced === null || !preserves(spliced, parsed, next)) {
		return { action: "conflict", reason: UNSPLICEABLE };
	}
	return { content: spliced, action: current ? "replaced" : "inserted" };
}

// A cortex entry that is not a table — `mcp_servers.cortex = 5`, or an
// `mcp_servers` that is not a table at all — reads as absent here on purpose:
// the insert it leads to is invalid TOML, and the check below refuses it with
// the same message as every other shape this cannot rewrite.
function cortexEntry(parsed: Table): Table | null {
	const servers = parsed[SERVERS_KEY];
	if (!isTable(servers)) return null;
	const cortex = servers[CORTEX_KEY];
	return isTable(cortex) ? cortex : null;
}

// Everything the config parsed to must still be there, with exactly the entry
// we meant to write and nothing else moved.
function preserves(spliced: string, before: Table, next: Table): boolean {
	const servers = before[SERVERS_KEY];
	const expected = {
		...before,
		[SERVERS_KEY]: {
			...(isTable(servers) ? servers : {}),
			[CORTEX_KEY]: next,
		},
	};
	return Bun.deepEquals(parseOrNull(spliced), expected, true);
}

function splice(
	content: string,
	table: string,
	replace: boolean,
): string | null {
	if (!replace) return appended(content, table);
	const lines = content.split("\n");
	const start = lines.findIndex(isCortexHeader);
	if (start === -1) return null;
	const next = [
		...lines.slice(0, start),
		...table.slice(0, -1).split("\n"),
		...lines.slice(tableEndLine(lines, start)),
	];
	return withFinalNewline(next.join("\n"));
}

// The table runs until the next header that is not one of its own sub-tables —
// `[mcp_servers.cortex.env]` belongs to the block being replaced, `[profiles]`
// does not — with any blank separator lines left to the neighbor below.
function tableEndLine(lines: string[], headerLine: number): number {
	let end = headerLine + 1;
	while (end < lines.length && belongsToCortexTable(lines[end] ?? "")) end += 1;
	while (end > headerLine + 1 && lines[end - 1]?.trim() === "") end -= 1;
	return end;
}

function belongsToCortexTable(line: string): boolean {
	const path = headerPath(line);
	if (!path) return !line.trimStart().startsWith("[");
	return path.length > CORTEX_TABLE_PATH.length && startsWithCortexPath(path);
}

function isCortexHeader(line: string): boolean {
	const path = headerPath(line);
	return (
		path !== null &&
		path.length === CORTEX_TABLE_PATH.length &&
		startsWithCortexPath(path)
	);
}

function startsWithCortexPath(path: string[]): boolean {
	return CORTEX_TABLE_PATH.every((key, index) => path[index] === key);
}

// Deliberately not a TOML parser: anything this misreads is caught by the
// re-parse of the spliced result, so it only has to recognize the spellings a
// person actually writes.
function headerPath(line: string): string[] | null {
	const text = line.trim();
	if (!text.startsWith("[") || text.startsWith("[[")) return null;
	const close = text.indexOf("]");
	if (close === -1) return null;
	const trailing = text.slice(close + 1).trim();
	if (trailing !== "" && !trailing.startsWith("#")) return null;
	return keyPath(text.slice(1, close));
}

function keyPath(inner: string): string[] | null {
	const path: string[] = [];
	const keys = splitOnDots(inner);
	if (!keys) return null;
	for (const raw of keys) {
		const key = unquoteKey(raw);
		if (key === null) return null;
		path.push(key);
	}
	return path;
}

function splitOnDots(inner: string): string[] | null {
	const keys: string[] = [];
	let current = "";
	let quote = "";
	for (const char of inner) {
		if (quote !== "") {
			current += char;
			if (char === quote) quote = "";
			continue;
		}
		if (char === ".") {
			keys.push(current);
			current = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		current += char;
	}
	if (quote !== "") return null;
	keys.push(current);
	return keys;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function unquoteKey(raw: string): string | null {
	const key = raw.trim();
	if (quoted(key, '"')) {
		const inner = key.slice(1, -1);
		return inner.includes("\\") ? null : inner;
	}
	if (quoted(key, "'")) return key.slice(1, -1);
	return BARE_KEY.test(key) ? key : null;
}

function quoted(key: string, mark: string): boolean {
	return key.length >= 2 && key.startsWith(mark) && key.endsWith(mark);
}

// Bun ships TOML.stringify; bun-types has not caught up with it, and the
// runtime is what this file targets. It is what renders a user-added key back
// out — `env` and its sub-table included — which is why the table is rebuilt
// from the parsed entry rather than from the spec alone.
const TOML = Bun.TOML as unknown as { stringify(value: unknown): string };

function renderCortexTable(entry: Table): string {
	return withFinalNewline(
		TOML.stringify({ [SERVERS_KEY]: { [CORTEX_KEY]: entry } }),
	);
}

function parseOrNull(content: string): Table | null {
	try {
		const parsed: unknown = Bun.TOML.parse(content);
		return isTable(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isTable(value: unknown): value is Table {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withFinalNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function appended(content: string, block: string): string {
	if (content.trim() === "") return block;
	return `${withFinalNewline(content)}\n${block}`;
}
