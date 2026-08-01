import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accessCodeIndex } from "@/app/code-index-access";
import type { CortexRuntime } from "@/app/runtime";
import { symbolHint } from "@/app/symbol-hints";
import { type CreateDecisionInput, createDecisionSchema } from "@/domain";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import type { CodeRepository } from "@/storage/code-repository";
import { projectPathField, scopedToProject } from "./project-scope";
import { guidanceResult, jsonResult } from "./results";

const DESCRIPTION = `Record a technical decision in the project's persistent memory (Cortex).

Call this whenever a non-trivial choice is made, confirmed, or reversed during the session: architecture, library or tool picks, schema changes, accepted trade-offs, rejected approaches. Write title and body factually and self-contained — they will be read months from now, without this conversation's context. Example: title "Adopt stateless JWT auth", body "Access tokens signed RS256, 15 min TTL, refresh tokens rotate in an httpOnly cookie. Rejected server-side sessions to keep the API stateless across instances."

Link related decisions: depends_on = ids this decision builds on (impact analysis walks these links); replaces = id of the decision this one supersedes (the old decision is archived, never deleted). anchors tie the decision to the files/symbols it governs so future readers of that code can find it. Symbol anchors use the qualified name from the code index (e.g. "AuthService.validateToken").

Returns { id, warnings } — warnings flag anchor files missing from the working tree and anchor symbols missing from the code index, with close-match suggestions (the decision is still saved).`;

export function registerSaveDecision(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"save_decision",
		{
			description: DESCRIPTION,
			inputSchema: {
				...createDecisionSchema.shape,
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, saveDecision),
	);
}

async function saveDecision(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
) {
	const missing = missingLinkedDecisions(runtime, input);
	if (missing.length > 0) {
		return guidanceResult(
			"not_found",
			`Linked decisions not found in this store: ${missing.join(", ")}. ` +
				"Nothing was saved — check the ids with get_context or search, then " +
				"retry with valid links or without them.",
		);
	}
	const warnings = [
		...anchorWarnings(runtime, input),
		...(await symbolWarnings(runtime, input)),
	];
	const context = runtime.saveContext();
	const decision = input.replaces
		? runtime.nodes.replaceDecision(input.replaces, input, context)
		: runtime.nodes.createDecision(input, context);
	runtime.queue?.enqueue(decision.id);
	runtime.semanticSearch.invalidate();
	return jsonResult({ id: decision.id, warnings });
}

function missingLinkedDecisions(
	runtime: CortexRuntime,
	input: CreateDecisionInput,
): string[] {
	const linked = [
		...(input.depends_on ?? []),
		...(input.replaces ? [input.replaces] : []),
	];
	return linked.filter((id) => runtime.nodes.getById(id) === null);
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
	const access = await accessCodeIndex(runtime.codeIndex);
	if (!access.ok) {
		return [`symbol anchors not validated — ${access.warning}`];
	}
	return anchored.flatMap((anchor) =>
		symbolWarning(access.code, anchor.file_path, anchor.symbol as string),
	);
}

function symbolWarning(
	code: CodeRepository,
	filePath: string,
	symbol: string,
): string[] {
	if (code.hasSymbol(filePath, symbol)) return [];
	const hint = symbolHint(code, filePath, symbol);
	return [`symbol not found in code index: ${symbol} (${filePath})${hint}`];
}
