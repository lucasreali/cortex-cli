import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "../runtime";
import { jsonResult } from "./results";

const DESCRIPTION = `Keyword and semantic search over the project's recorded decisions (Cortex).

Pass several terms, mixing Portuguese and English variants of the same concept — e.g. ["autenticação", "authentication", "jwt", "login"] — terms are OR-ed and matching ignores accents ("decisao" finds "decisão"). With exact=true only literal full-text matches return (fast and precise, good for error messages, library names, and qualified symbols like "AuthService.validateToken"). Default (false) also ranks semantically when the embedding model is available, so conceptually related decisions surface even without term overlap.

Returns compact results: id, title, score, and source ("vector" = semantic match, "fts" = textual match). Use get_impact on an id before changing what you find.`;

export function registerSearch(
	server: McpServer,
	runtime: CortexRuntime,
): void {
	server.registerTool(
		"search",
		{
			description: DESCRIPTION,
			inputSchema: {
				terms: z
					.array(z.string().min(1))
					.min(1)
					.describe(
						"Search terms. Pass multiple variants, mixing PT and EN, plus concrete identifiers when relevant.",
					),
				exact: z
					.boolean()
					.optional()
					.describe(
						"true = literal full-text matching only; false/omitted = also rank semantically.",
					),
			},
		},
		async (args) => search(runtime, args),
	);
}

async function search(
	runtime: CortexRuntime,
	args: { terms: string[]; exact?: boolean },
) {
	if (args.exact)
		return jsonResult({ results: exactSearch(runtime, args.terms) });
	const results = await runtime.semanticSearch.search(args.terms.join(" "));
	return jsonResult({
		results: results.map((result) => ({
			id: result.node.id,
			title: result.node.title,
			module: result.node.module,
			score: Number(result.score.toFixed(3)),
			source: result.source,
		})),
	});
}

function exactSearch(runtime: CortexRuntime, terms: string[]) {
	return runtime.fts.searchExact(terms).flatMap((hit) => {
		const node = runtime.nodes.getById(hit.nodeId);
		if (node?.status !== "active") return [];
		return [
			{
				id: node.id,
				title: node.title,
				module: node.module,
				score: Number((-hit.rank).toFixed(3)),
				source: "fts" as const,
			},
		];
	});
}
