import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Decision } from "@/domain";
import { CodeImpactAnalysis } from "@/storage/code-impact";
import type { CortexRuntime } from "../runtime";
import { errorResult, jsonResult } from "./results";

const DESCRIPTION = `List every decision affected by changing a given decision, through two lenses.

Call this before modifying, replacing, or contradicting a recorded decision. "impacted" walks explicit DEPENDS_ON links in both directions — decisions this one builds on, and decisions built on it — up to max_depth hops. "code_impacted" walks the code: decisions anchored to files that transitively import the files this decision is anchored to, up to code_depth import hops. Code entries carry provenance — "exact" import chains are reliably resolved, "heuristic" ones come from inferred resolution and may be wrong; treat them as leads, not proof. Use the returned ids with get_context or search for full detail.`;

const DEFAULT_DEPTH = 3;

export function registerGetImpact(
	server: McpServer,
	runtime: CortexRuntime,
): void {
	server.registerTool(
		"get_impact",
		{
			description: DESCRIPTION,
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
			},
		},
		async (args) => getImpact(runtime, args),
	);
}

async function getImpact(
	runtime: CortexRuntime,
	args: { decision_id: string; max_depth?: number; code_depth?: number },
) {
	const root = runtime.nodes.getById(args.decision_id);
	if (!root) return errorResult(`decision not found: ${args.decision_id}`);
	const impacted = runtime.edges
		.getImpact(args.decision_id, args.max_depth ?? DEFAULT_DEPTH)
		.flatMap(({ nodeId, depth }) => {
			const node = runtime.nodes.getById(nodeId);
			if (!node) return [];
			return [
				{
					id: node.id,
					depth,
					title: node.title,
					status: node.status,
					anchors: node.anchors,
				},
			];
		});
	const code = await codeImpact(
		runtime,
		root,
		args.code_depth ?? DEFAULT_DEPTH,
	);
	return jsonResult({
		decision: { id: root.id, title: root.title, anchors: root.anchors },
		impacted,
		...code,
	});
}

async function codeImpact(
	runtime: CortexRuntime,
	root: Decision,
	depth: number,
) {
	if (root.anchors.length === 0) return { code_impacted: [] };
	try {
		const repository = await runtime.codeIndex.repository();
		const analysis = new CodeImpactAnalysis(runtime.nodes, repository);
		const code_impacted = analysis.forDecision(root, depth).map((entry) => ({
			id: entry.decision.id,
			title: entry.decision.title,
			status: entry.decision.status,
			file: entry.filePath,
			depth: entry.depth,
			provenance: entry.provenance,
		}));
		return { code_impacted };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			code_impacted: [],
			code_warning: `code index unavailable: ${message}`,
		};
	}
}
