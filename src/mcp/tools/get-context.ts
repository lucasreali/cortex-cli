import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	anchorsByDecision,
	type ResolvedAnchor,
} from "@/app/anchor-confidence";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { contextQuery } from "@/querylog/entry";
import { truncate } from "@/support/text";
import { anchorEntries } from "./anchor-entry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const SUMMARY_LIMIT = 200;

const DESCRIPTION = `Fetch decision context from this project's memory (Cortex). Call it before proposing or changing an approach.

With "intent" (a question in Portuguese or English) it returns the most relevant decisions in rank order, each with source "vector" (semantic) or "fts" (textual fallback). Without it, it returns the known modules, the most recent decisions and recent session summaries.

Entries are compact; read the full rationale with get_decision. Anchor confidence: "exact" (file declares the symbol), "name_only" (symbol lives elsewhere — likely moved), "file_only", "unresolved" (file or symbol gone), "unknown" (index unreadable). Trust "exact"; treat the rest as hints.`;

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
	const filtered = await runtime.semanticSearch.search(intent, { module });
	// Only the intent path records: the overview lists the most recent
	// decisions, which is browsing rather than a judgement about relevance, and
	// counting it would mark every new decision as passed over.
	runtime.usefulness.shown(filtered.map((result) => result.node.id));
	// The opt-in query log, for the same reason and with the opposite default:
	// the intent is a question someone asked, not an id this store already
	// holds, so it is recorded only where the user turned it on.
	runtime.queries.record(
		contextQuery(intent, module ?? null),
		filtered.map((result) => result.node.id),
	);
	const nodes = filtered.map((result) => result.node);
	const conflicts = conflictsOf(runtime, nodes);
	const anchors = await anchorsByDecision(runtime, nodes);
	return jsonResult({
		decisions: filtered.map((result, index) =>
			searchEntry(result, index, conflicts, anchors),
		),
		...(filtered.length === 0 ? { guidance: NO_MATCH_GUIDANCE } : {}),
	});
}

async function overviewContext(runtime: CortexRuntime, module?: string) {
	const recent = runtime.nodes.listActive({ module, limit: RECENT_LIMIT });
	const conflicts = conflictsOf(runtime, recent);
	const anchors = await anchorsByDecision(runtime, recent);
	return jsonResult({
		project: runtime.projectCanonicalId,
		modules: runtime.nodes.listModules(),
		decisions: recent.map((decision) =>
			decisionEntry(decision, conflicts, anchors),
		),
		sessions: runtime.sessionSummaries.list(
			SESSION_LIMIT,
			runtime.nodes.listSessionSummaries(SESSION_LIMIT),
		),
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

// The rank, not the fused score: a reciprocal-rank score tops out near 0.03,
// which reads to a model as "barely relevant" even for the best match there is.
function searchEntry(
	result: SemanticSearchResult,
	index: number,
	conflicts: Map<string, string[]>,
	anchors: Map<string, ResolvedAnchor[]>,
) {
	return {
		rank: index + 1,
		...decisionEntry(result.node, conflicts, anchors),
		source: result.source,
	};
}

function decisionEntry(
	decision: Decision,
	conflicts: Map<string, string[]>,
	anchors: Map<string, ResolvedAnchor[]>,
) {
	const partners = conflicts.get(decision.id) ?? [];
	const resolved = anchors.get(decision.id) ?? [];
	return {
		id: decision.id,
		title: decision.title,
		summary: truncate(decision.body, SUMMARY_LIMIT),
		module: decision.module,
		createdAt: decision.createdAt,
		...(partners.length > 0 ? { conflicts_with: partners } : {}),
		...(resolved.length > 0 ? { anchors: anchorEntries(resolved) } : {}),
	};
}
