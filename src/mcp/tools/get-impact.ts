import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "../runtime";
import { errorResult, jsonResult } from "./results";

const DESCRIPTION = `List every decision affected by changing a given decision.

Call this before modifying, replacing, or contradicting a recorded decision. It walks DEPENDS_ON links in both directions — decisions this one builds on, and decisions built on it — up to max_depth hops, and returns each affected decision with its anchors (the files/symbols it governs), ordered by distance. Use the returned ids with get_context or search for full detail.`;

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
			},
		},
		async (args) => getImpact(runtime, args),
	);
}

function getImpact(
	runtime: CortexRuntime,
	args: { decision_id: string; max_depth?: number },
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
	return jsonResult({
		decision: { id: root.id, title: root.title, anchors: root.anchors },
		impacted,
	});
}
