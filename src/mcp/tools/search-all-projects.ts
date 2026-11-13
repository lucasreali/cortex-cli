import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type AllProjectsSearch,
	type ProjectSearchResults,
	type SweepTarget,
	searchAllProjects,
} from "@/app/search-all-projects";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import { getCanonicalProjectId } from "@/git";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import {
	type ProjectRegistryRead,
	projectsRegistryPath,
	readProjectRegistry,
} from "@/storage/project-registry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { errorResult, guidanceResult, jsonResult } from "./results";

const DESCRIPTION = `Search decisions across every Cortex project on this machine, for questions beyond the current project ("how did I handle rate limiting elsewhere?").

Results are grouped per project and never merged, because scores are not comparable across stores. Terms behave as in search. Projects that could not be opened or reached are listed under "skipped" with a reason. Questions about this project belong to search or get_context.`;

const NO_PROJECTS_GUIDANCE =
	"No Cortex projects registered on this machine yet. A project registers " +
	"when `cortex init` runs there or when a session first touches it; after " +
	"that, this tool can search it.";

function registryUnreadableGuidance(): string {
	return (
		`The project registry at ${projectsRegistryPath()} is not valid JSON, so ` +
		"no project could be listed. It is kept as a `.corrupt.<timestamp>` " +
		"sibling the next time a project registers; run `cortex doctor` for the " +
		"details."
	);
}

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
	const registered = readProjectRegistry();
	const targets = knownTargets(registered, registry);
	if (targets.length === 0) {
		if (registered.state === "unreadable") {
			return guidanceResult(
				"registry_unreadable",
				registryUnreadableGuidance(),
			);
		}
		return guidanceResult("no_projects", NO_PROJECTS_GUIDANCE);
	}
	const exact = args.exact === true;
	const outcome = await searchAllProjects({
		targets,
		open: (root) => registry.openReader(root),
		terms: args.terms,
		exact,
		vector: exact ? null : await registry.embedSweepQuery(args.terms.join(" ")),
	});
	return jsonResult(toPayload(outcome, registered));
}

// The canonical id comes from the registry rather than from `git` in each
// project: labelling 200 projects must not cost 600 blocking subprocesses.
function knownTargets(
	registered: ProjectRegistryRead,
	registry: RuntimeRegistry,
): SweepTarget[] {
	const targets: SweepTarget[] =
		registered.state === "ok"
			? registered.projects.map((entry) => ({
					root: entry.root,
					canonicalId: entry.canonicalId,
				}))
			: [];
	const current = registry.defaultRoot;
	if (current && !targets.some((target) => target.root === current)) {
		targets.push({
			root: current,
			canonicalId: getCanonicalProjectId(current) ?? current,
		});
	}
	return targets;
}

// An unreadable registry narrows the sweep to whatever root the session already
// had, so the answer has to say it is partial instead of reading as complete.
function toPayload(
	outcome: AllProjectsSearch,
	registered: ProjectRegistryRead,
) {
	return {
		projects: outcome.projects.map(projectEntry),
		...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
		...(registered.state === "unreadable"
			? { registry_unreadable: projectsRegistryPath() }
			: {}),
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
