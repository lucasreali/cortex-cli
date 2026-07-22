import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(payload: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// Recoverable conditions (project not initialized, id not found) answer
// success-shaped: an early isError teaches the agent the toolset is broken
// and it stops calling it for the rest of the session.
export function guidanceResult(
	status: string,
	guidance: string,
): CallToolResult {
	return jsonResult({ status, guidance });
}

export function errorResult(error: unknown): CallToolResult {
	const message = error instanceof Error ? error.message : String(error);
	return { isError: true, content: [{ type: "text", text: message }] };
}
