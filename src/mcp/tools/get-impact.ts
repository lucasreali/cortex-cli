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

Call this before modifying, replacing, or contradicting a recorded decision. "impacted" walks explicit DEPENDS_ON links in both directions — decisions this one builds on, and decisions built on it — up to max_depth hops. "code_impacted" walks the code: decisions anchored to files that transitively import the files this decision is anchored to, up to code_depth import hops. Code entries carry provenance — "exact" import chains are reliably resolved, "heuristic" ones come from inferred resolution and may be wrong; treat them as leads, not proof. If the code index cannot be loaded, code_impacted comes back empty with a code_warning explaining why. Use the returned ids with get_context or search for full detail.`;

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
					.uuid()
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

async function getImpact(
	runtime: CortexRuntime,
	args: { decision_id: string; max_depth?: number; code_depth?: number },
) {
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
	return jsonResult(toPayload(impact));
}

function toPayload(impact: DecisionImpact) {
	const { root } = impact;
	return {
		decision: { id: root.id, title: root.title, anchors: root.anchors },
		impacted: impact.impacted.map(({ node, depth }) => ({
			id: node.id,
			depth,
			title: node.title,
			status: node.status,
			anchors: node.anchors,
		})),
		code_impacted: impact.codeImpacted.map((entry) => ({
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
