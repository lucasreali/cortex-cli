import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import { jsonResult } from "./results";

const DESCRIPTION = `Fetch decision context from the project's persistent memory (Cortex).

Call this when starting work on a task, before proposing an architectural change, or whenever you need to know why something is the way it is. With "intent" — a natural-language question, Portuguese or English, e.g. "como autenticamos usuários?" or "how do we paginate lists?" — it runs semantic search and returns the most relevant decisions ranked by score, each tagged with source ("vector" = semantic match; "fts" = textual fallback, used while the embedding model is cold or unavailable). Without "intent" it returns the project identity, the list of known modules (valid values for the module filter), the most recent active decisions and recent session summaries.

Results are compact (id, title, summary). Use get_impact on an id to see what a decision affects, or search for keyword lookup.`;

const RECENT_LIMIT = 10;
const SESSION_LIMIT = 5;

export function registerGetContext(
	server: McpServer,
	runtime: CortexRuntime,
): void {
	server.registerTool(
		"get_context",
		{
			description: DESCRIPTION,
			inputSchema: {
				intent: z
					.string()
					.min(1)
					.optional()
					.describe(
						"Natural-language question about the project (PT or EN). Triggers semantic search. Omit to list recent decisions instead.",
					),
				module: z
					.string()
					.optional()
					.describe(
						"Restrict results to one module (as set on save_decision).",
					),
			},
		},
		async (args) => getContext(runtime, args),
	);
}

async function getContext(
	runtime: CortexRuntime,
	args: { intent?: string; module?: string },
) {
	if (args.intent) {
		const results = await runtime.semanticSearch.search(args.intent);
		const filtered = args.module
			? results.filter((result) => result.node.module === args.module)
			: results;
		return jsonResult({ decisions: filtered.map(searchEntry) });
	}
	const recent = runtime.nodes
		.listActive({ module: args.module })
		.slice(0, RECENT_LIMIT);
	return jsonResult({
		project: runtime.projectCanonicalId,
		modules: runtime.nodes.listModules(),
		decisions: recent.map(decisionEntry),
		sessions: runtime.nodes.listSessionSummaries(SESSION_LIMIT),
	});
}

function searchEntry(result: SemanticSearchResult) {
	return {
		...decisionEntry(result.node),
		score: Number(result.score.toFixed(3)),
		source: result.source,
	};
}

function decisionEntry(decision: Decision) {
	return {
		id: decision.id,
		title: decision.title,
		summary: truncate(decision.body, 200),
		module: decision.module,
		createdAt: decision.createdAt,
	};
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
