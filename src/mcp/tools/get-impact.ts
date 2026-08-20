import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DecisionImpact } from "@/app/decision-impact";
import { decisionImpact } from "@/app/decision-impact";
import type { CortexRuntime } from "@/app/runtime";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { projectPathField, scopedToProject } from "./project-scope";
import { guidanceResult, jsonResult } from "./results";

const DESCRIPTION = `List every decision affected by changing a given decision, through two lenses.

Call this before modifying, replacing, or contradicting a recorded decision. "impacted" walks explicit DEPENDS_ON links in both directions — decisions this one builds on, and decisions built on it — up to max_depth hops. "code_impacted" walks the code: decisions anchored to files that transitively import the files this decision is anchored to, up to code_depth import hops. Code entries carry provenance — "exact" import chains are reliably resolved, "heuristic" ones come from inferred resolution and may be wrong; treat them as leads, not proof. Every anchor carries a confidence, resolved against this checkout: "exact" (the file declares that symbol), "name_only" (the symbol lives in another file — likely moved or renamed), "file_only" (a file-level anchor, or a symbol the index cannot judge), "unresolved" (the file is gone, or the symbol vanished from a file that is indexed) and "unknown" (the code index could not be read — see code_warning). Weigh an "exact" anchor above a weaker one. If the code index cannot be loaded, code_impacted comes back empty with a code_warning explaining why. Use the returned ids with get_context or search for full detail.`;

export function registerGetImpact(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"get_impact",
		{
			description: DESCRIPTION,
			annotations: READ_ONLY_ANNOTATIONS,
			inputSchema: {
				decision_id: z
					.string()
					.min(1)
					.describe("Decision id, as returned by save_decision or search."),
				max_depth: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.describe("How many dependency hops to walk (default 3)."),
				code_depth: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.describe(
						"How many import hops to walk for code impact (default 3).",
					),
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, getImpact),
	);
}

// The id is validated here rather than by the tool schema: a malformed one is
// a recoverable mistake the agent can fix from the guidance, and the SDK would
// answer it with a raw zod dump under isError instead.
async function getImpact(
	runtime: CortexRuntime,
	args: { decision_id: string; max_depth?: number; code_depth?: number },
) {
	if (!z.uuid().safeParse(args.decision_id).success) {
		return guidanceResult(
			"invalid_id",
			`"${args.decision_id}" is not a decision id. Ids are uuids, as ` +
				"returned by save_decision, search or get_context — pass one of " +
				"those, not a title or a file path.",
		);
	}
	const impact = await decisionImpact(runtime, args.decision_id, {
		maxDepth: args.max_depth,
		codeDepth: args.code_depth,
	});
	if (!impact) {
		return guidanceResult(
			"not_found",
			`No decision ${args.decision_id} in this project's store. List valid ` +
				"ids with get_context or search; if the decision lives in another " +
				"project, pass its projectPath.",
		);
	}
	// A read-only tool that writes: the annotation is about the product — no
	// decision file, row or edge changes here — while the local sidecar records
	// ids and timestamps inside this repo alone. Nothing a query said leaves the
	// machine, which is what would force the opt-in posture instead.
	runtime.usefulness.used([args.decision_id]);
	return jsonResult(toPayload(impact));
}

// A decision at the centre of a large graph can reach thousands of others, and
// this is the tool whose whole purpose is context economy: the answer is capped
// and says so, rather than shipping a multi-megabyte blob into the context.
const MAX_ENTRIES = 100;

function toPayload(impact: DecisionImpact) {
	const { root } = impact;
	return {
		decision: {
			id: root.id,
			title: root.title,
			status: root.status,
			anchors: root.anchors,
		},
		...truncationMarker(impact),
		impacted: impact.impacted.slice(0, MAX_ENTRIES).map(({ node, depth }) => ({
			id: node.id,
			depth,
			title: node.title,
			status: node.status,
			anchors: node.anchors,
		})),
		code_impacted: impact.codeImpacted.slice(0, MAX_ENTRIES).map((entry) => ({
			id: entry.decision.id,
			title: entry.decision.title,
			status: entry.decision.status,
			file: entry.filePath,
			depth: entry.depth,
			provenance: entry.provenance,
		})),
		...(impact.codeWarning === null
			? {}
			: { code_warning: impact.codeWarning }),
	};
}

function truncationMarker(impact: DecisionImpact) {
	const dropped =
		Math.max(0, impact.impacted.length - MAX_ENTRIES) +
		Math.max(0, impact.codeImpacted.length - MAX_ENTRIES);
	if (dropped === 0) return {};
	return {
		truncated: {
			shown_per_lens: MAX_ENTRIES,
			omitted: dropped,
			guidance:
				"This decision reaches more entries than one answer carries. " +
				"Narrow the walk with a smaller max_depth or code_depth.",
		},
	};
}
