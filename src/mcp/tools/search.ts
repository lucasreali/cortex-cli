import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import { searchDecisions } from "@/app/search-decisions";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import type { RuntimeRegistry } from "../runtime-registry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const DESCRIPTION = `Keyword and semantic search over the project's recorded decisions (Cortex).

Pass several terms, mixing Portuguese and English variants of the same concept — e.g. ["autenticação", "authentication", "jwt", "login"] — terms are OR-ed and matching ignores accents ("decisao" finds "decisão"). With exact=true only literal full-text matches return (fast and precise, good for error messages, library names, and qualified symbols like "AuthService.validateToken"). Default (false) also ranks semantically when the embedding model is available, so conceptually related decisions surface even without term overlap.

Returns compact results: id, title, score, and source ("vector" = semantic match, "fts" = textual match). Use get_impact on an id before changing what you find.`;

const NO_MATCH_GUIDANCE =
	"No decision matched these terms. Retry with broader PT/EN variants, or " +
	"call get_context without intent to browse what is recorded.";

export function registerSearch(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"search",
		{
			description: DESCRIPTION,
			annotations: READ_ONLY_ANNOTATIONS,
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
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, search),
	);
}

async function search(
	runtime: CortexRuntime,
	args: { terms: string[]; exact?: boolean },
) {
	const results = await searchDecisions(
		runtime,
		args.terms,
		args.exact === true,
	);
	return jsonResult({
		results: results.map(resultEntry),
		...(results.length === 0 ? { guidance: NO_MATCH_GUIDANCE } : {}),
	});
}

function resultEntry(result: SemanticSearchResult) {
	return {
		id: result.node.id,
		title: result.node.title,
		module: result.node.module,
		score: Number(result.score.toFixed(3)),
		source: result.source,
	};
}
