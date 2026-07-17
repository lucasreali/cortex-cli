import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(payload: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function errorResult(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: message }] };
}
