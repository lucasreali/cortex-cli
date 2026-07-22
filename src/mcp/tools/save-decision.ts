import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CreateDecisionInput, createDecisionSchema } from "@/domain";
import type { CodeRepository } from "@/storage/code-repository";
import type { CortexRuntime } from "@/app/runtime";
import { errorResult, jsonResult } from "./results";

const DESCRIPTION = `Record a technical decision in the project's persistent memory (Cortex).

Call this whenever a non-trivial choice is made, confirmed, or reversed during the session: architecture, library or tool picks, schema changes, accepted trade-offs, rejected approaches. Write title and body factually and self-contained — they will be read months from now, without this conversation's context. Example: title "Adopt stateless JWT auth", body "Access tokens signed RS256, 15 min TTL, refresh tokens rotate in an httpOnly cookie. Rejected server-side sessions to keep the API stateless across instances."

Link related decisions: depends_on = ids this decision builds on (impact analysis walks these links); replaces = id of the decision this one supersedes (the old decision is archived, never deleted). anchors tie the decision to the files/symbols it governs so future readers of that code can find it. Symbol anchors use the qualified name from the code index (e.g. "AuthService.validateToken").

Returns { id, warnings } — warnings flag anchor files missing from the working tree and anchor symbols missing from the code index, with close-match suggestions (the decision is still saved).`;

const SUGGESTION_LIMIT = 3;

export function registerSaveDecision(
	server: McpServer,
	runtime: CortexRuntime,
): void {
	server.registerTool(
		"save_decision",
		{ description: DESCRIPTION, inputSchema: createDecisionSchema.shape },
		async (args) => saveDecision(runtime, args as CreateDecisionInput),
	);
}

async function saveDecision(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
) {
	const warnings = [
		...anchorWarnings(runtime, input),
		...(await symbolWarnings(runtime, input)),
	];
	try {
		const context = runtime.saveContext();
		const decision = input.replaces
			? runtime.nodes.replaceDecision(input.replaces, input, context)
			: runtime.nodes.createDecision(input, context);
		runtime.queue?.enqueue(decision.id);
		runtime.semanticSearch.invalidate();
		return jsonResult({ id: decision.id, warnings });
	} catch (error) {
		return errorResult(error);
	}
}

function anchorWarnings(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
): string[] {
	return (input.anchors ?? [])
		.filter((anchor) => !existsSync(join(runtime.repoRoot, anchor.file_path)))
		.map(
			(anchor) => `anchor file not found in working tree: ${anchor.file_path}`,
		);
}

async function symbolWarnings(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
): Promise<string[]> {
	const anchored = (input.anchors ?? []).filter((anchor) => anchor.symbol);
	if (anchored.length === 0) return [];
	try {
		const code = await runtime.codeIndex.repository();
		return anchored.flatMap((anchor) =>
			symbolWarning(code, anchor.file_path, anchor.symbol as string),
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return [
			`symbol anchors not validated — code index unavailable: ${message}`,
		];
	}
}

function symbolWarning(
	code: CodeRepository,
	filePath: string,
	symbol: string,
): string[] {
	if (code.hasSymbol(filePath, symbol)) return [];
	const suggestions = code.suggestSymbols(filePath, symbol, SUGGESTION_LIMIT);
	const hint =
		suggestions.length > 0 ? ` — did you mean: ${suggestions.join(", ")}?` : "";
	return [`symbol not found in code index: ${symbol} (${filePath})${hint}`];
}
