import type { McpServerSpec } from "./server-spec";

export const CORTEX_TABLE_HEADER = "[mcp_servers.cortex]";

export type TomlUpsertAction = "inserted" | "replaced" | "unchanged";

export interface TomlUpsert {
	content: string;
	action: TomlUpsertAction;
}

export function buildCortexTable(spec: McpServerSpec): string {
	const args = spec.args.map(quote).join(", ");
	return `${CORTEX_TABLE_HEADER}\ncommand = ${quote(spec.command)}\nargs = [${args}]\n`;
}

// A surgical line splice instead of a TOML parser: only the cortex table is
// ever touched, so the rest of the user's config survives byte-for-byte —
// comments and formatting included, which no parse-and-serialize round trip
// can promise.
export function upsertTomlTable(
	content: string,
	header: string,
	block: string,
): TomlUpsert {
	const lines = content.split("\n");
	const headerLine = lines.indexOf(header);
	if (headerLine === -1) {
		return { content: appended(content, block), action: "inserted" };
	}
	const end = tableEndLine(lines, headerLine);
	const blockLines = block.slice(0, -1).split("\n");
	if (equalLines(lines.slice(headerLine, end), blockLines)) {
		return { content, action: "unchanged" };
	}
	const next = [
		...lines.slice(0, headerLine),
		...blockLines,
		...lines.slice(end),
	].join("\n");
	return { content: withFinalNewline(next), action: "replaced" };
}

// The table runs until the next header line — `[table]` and `[[array]]` both
// end it — with any blank separator lines left to the neighbor below.
function tableEndLine(lines: string[], headerLine: number): number {
	let end = headerLine + 1;
	while (end < lines.length && !lines[end]?.startsWith("[")) end += 1;
	while (end > headerLine + 1 && lines[end - 1]?.trim() === "") end -= 1;
	return end;
}

function equalLines(current: string[], next: string[]): boolean {
	return (
		current.length === next.length &&
		current.every((line, index) => line === next[index])
	);
}

function withFinalNewline(content: string): string {
	return content.endsWith("\n") ? content : `${content}\n`;
}

function appended(content: string, block: string): string {
	if (content === "") return block;
	return `${withFinalNewline(content)}\n${block}`;
}

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
