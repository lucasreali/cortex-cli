import { existsSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { accessCodeIndex } from "@/app/code-index-access";
import { conflictCandidates } from "@/app/conflict-candidates";
import type { CortexRuntime } from "@/app/runtime";
import { symbolHint } from "@/app/symbol-hints";
import { type CreateDecisionInput, createDecisionSchema } from "@/domain";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import type { CodeRepository } from "@/storage/code-repository";
import { projectPathField, scopedToProject } from "./project-scope";
import { guidanceResult, jsonResult } from "./results";

const DESCRIPTION = `Record a technical decision in this project's memory (Cortex) when a non-trivial choice is made, confirmed or reversed.

A decision is a choice and its reasons, not a changelog or a bug report: state what was chosen, why, and which alternatives were rejected, in about 120 words a reader can follow months from now without this conversation. Fixes and incident narratives belong in commits.

Links: depends_on = ids this builds on; replaces = id it supersedes; archives = id that no longer applies and has no successor; conflicts_with = ids it contradicts without superseding. anchors = files/symbols it governs (qualified names as indexed, e.g. "AuthService.validateToken").

Returns { id, warnings, conflict_candidates }. Review each candidate: if it truly contradicts this decision, save again with replaces or conflicts_with.`;

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
	const linked = linkedDecisions(input);
	const missing = linked.filter((id) => runtime.nodes.getById(id) === null);
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
	const candidates = conflictCandidates(runtime, input);
	// Citing a decision in a link is the least ambiguous evidence there is that
	// the session acted on it.
	runtime.usefulness.used(linked);
	const saved = runtime.decisions.save(input, runtime.saveContext());
	runtime.queue?.enqueue(saved.id);
	runtime.semanticSearch.invalidate();
	return jsonResult({
		id: saved.id,
		warnings,
		conflict_candidates: candidates,
	});
}

function linkedDecisions(input: CreateDecisionInput): string[] {
	return [
		...(input.depends_on ?? []),
		...(input.conflicts_with ?? []),
		...(input.replaces ? [input.replaces] : []),
		...(input.archives ? [input.archives] : []),
	];
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
