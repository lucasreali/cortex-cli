import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type AllProjectsSearch,
	type ProjectSearchResults,
	searchAllProjects,
} from "@/app/search-all-projects";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { readRegisteredProjects } from "@/storage/project-registry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { errorResult, guidanceResult, jsonResult } from "./results";

const DESCRIPTION = `Search decisions across every Cortex project on this machine (Cortex).

Call this for questions that reach beyond the current project — "how did I solve rate limiting in my other projects?", "have I picked an auth library before?". It fans out over all registered projects (a project registers when it is initialized or first used) and returns results grouped per project, each labeled with its project identity. Scores are not comparable across projects, so groups are never merged into one ranking.

Questions about the current project belong to search or get_context — this tool is deliberately separate so scoped reads stay scoped. Terms behave exactly like search: pass PT/EN variants, exact=true for literal matching only. Projects that fail to open are listed under "skipped" with a reason.`;

const NO_PROJECTS_GUIDANCE =
	"No Cortex projects registered on this machine yet. A project registers " +
	"when `cortex init` runs there or when a session first touches it; after " +
	"that, this tool can search it.";

export function registerSearchAllProjects(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"search_all_projects",
		{
			description: DESCRIPTION,
			annotations: READ_ONLY_ANNOTATIONS,
			inputSchema: {
				terms: z
					.array(z.string().min(1))
					.min(1)
					.describe(
						"Search terms, as in search: multiple PT/EN variants of the concept.",
					),
				exact: z
					.boolean()
					.optional()
					.describe(
						"true = literal full-text matching only; false/omitted = also rank semantically.",
					),
			},
		},
		async (args: { terms: string[]; exact?: boolean }) => {
			try {
				return await searchEverywhere(registry, args);
			} catch (error) {
				return errorResult(error);
			}
		},
	);
}

async function searchEverywhere(
	registry: RuntimeRegistry,
	args: { terms: string[]; exact?: boolean },
) {
	const roots = knownRoots(registry);
	if (roots.length === 0) {
		return guidanceResult("no_projects", NO_PROJECTS_GUIDANCE);
	}
	const outcome = await searchAllProjects(
		roots,
		(root) => registry.openRoot(root),
		args.terms,
		args.exact === true,
	);
	return jsonResult(toPayload(outcome));
}

function knownRoots(registry: RuntimeRegistry): string[] {
	const roots = readRegisteredProjects().map((project) => project.root);
	const current = registry.defaultRoot;
	if (current && !roots.includes(current)) roots.push(current);
	return roots;
}

function toPayload(outcome: AllProjectsSearch) {
	return {
		projects: outcome.projects.map(projectEntry),
		...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
	};
}

function projectEntry(project: ProjectSearchResults) {
	return {
		project: project.project,
		results: project.results.map(resultEntry),
	};
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
