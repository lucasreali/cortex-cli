import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { truncate } from "@/support/text";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const SUMMARY_LIMIT = 200;

const DESCRIPTION = `Fetch decision context from the project's persistent memory (Cortex).

Call this when starting work on a task, before proposing an architectural change, or whenever you need to know why something is the way it is. With "intent" — a natural-language question, Portuguese or English, e.g. "como autenticamos usuários?" or "how do we paginate lists?" — it runs semantic search and returns the most relevant decisions ranked by score, each tagged with source ("vector" = semantic match; "fts" = textual fallback, used while the embedding model is cold or unavailable). Without "intent" it returns the project identity, the list of known modules (valid values for the module filter), the most recent active decisions and recent session summaries.

Results are compact (id, title, summary). Use get_impact on an id to see what a decision affects, or search for keyword lookup.`;

const RECENT_LIMIT = 10;
const SESSION_LIMIT = 5;

const NO_MATCH_GUIDANCE =
	"No recorded decision matched this intent. Retry via search with PT/EN " +
	"keyword variants, or omit intent to browse recent decisions.";
const EMPTY_STORE_GUIDANCE =
	"No active decisions here yet. If module was set, check it against the " +
	"modules list; otherwise record decisions with save_decision as choices " +
	"are made.";

export function registerGetContext(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"get_context",
		{
			description: DESCRIPTION,
			annotations: READ_ONLY_ANNOTATIONS,
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
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, getContext),
	);
}

async function getContext(
	runtime: CortexRuntime,
	args: { intent?: string; module?: string },
) {
	if (args.intent) return intentContext(runtime, args.intent, args.module);
	return overviewContext(runtime, args.module);
}

async function intentContext(
	runtime: CortexRuntime,
	intent: string,
	module?: string,
) {
	const results = await runtime.semanticSearch.search(intent);
	const filtered = module
		? results.filter((result) => result.node.module === module)
		: results;
	const conflicts = conflictsOf(
		runtime,
		filtered.map((result) => result.node),
	);
	return jsonResult({
		decisions: filtered.map((result) => searchEntry(result, conflicts)),
		...(filtered.length === 0 ? { guidance: NO_MATCH_GUIDANCE } : {}),
	});
}

function overviewContext(runtime: CortexRuntime, module?: string) {
	const recent = runtime.nodes.listActive({ module }).slice(0, RECENT_LIMIT);
	const conflicts = conflictsOf(runtime, recent);
	return jsonResult({
		project: runtime.projectCanonicalId,
		modules: runtime.nodes.listModules(),
		decisions: recent.map((decision) => decisionEntry(decision, conflicts)),
		sessions: runtime.nodes.listSessionSummaries(SESSION_LIMIT),
		...(recent.length === 0 ? { guidance: EMPTY_STORE_GUIDANCE } : {}),
	});
}

function conflictsOf(
	runtime: CortexRuntime,
	decisions: Decision[],
): Map<string, string[]> {
	return runtime.edges.listConflictPartners(
		decisions.map((decision) => decision.id),
	);
}

function searchEntry(
	result: SemanticSearchResult,
	conflicts: Map<string, string[]>,
) {
	return {
		...decisionEntry(result.node, conflicts),
		score: Number(result.score.toFixed(3)),
		source: result.source,
	};
}

function decisionEntry(decision: Decision, conflicts: Map<string, string[]>) {
	const partners = conflicts.get(decision.id) ?? [];
	return {
		id: decision.id,
		title: decision.title,
		summary: truncate(decision.body, SUMMARY_LIMIT),
		module: decision.module,
		createdAt: decision.createdAt,
		...(partners.length > 0 ? { conflicts_with: partners } : {}),
	};
}
