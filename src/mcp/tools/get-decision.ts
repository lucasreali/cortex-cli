import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { anchorsByDecision } from "@/app/anchor-confidence";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import type { VersionedLinks } from "@/storage/edge-repository";
import { anchorEntries } from "./anchor-entry";
import { READ_ONLY_ANNOTATIONS } from "./annotations";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const MAX_IDS = 20;

const DESCRIPTION = `Read decisions in full by id (Cortex): the complete body — the why, the alternatives rejected, the trade-offs — plus keywords, anchors with their confidence, and the links to what each decision builds on, replaced or was replaced by.

get_context and search return compact entries; call this on the ids worth reading before acting on them.`;

export function registerGetDecision(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"get_decision",
		{
			description: DESCRIPTION,
			annotations: READ_ONLY_ANNOTATIONS,
			inputSchema: {
				ids: z
					.array(z.string().min(1))
					.min(1)
					.max(MAX_IDS)
					.describe("Decision ids, as returned by get_context or search."),
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, getDecision),
	);
}

// A replaced or off-branch decision is still returned, labelled: an agent
// that follows a replaced_by link has to be able to read where it came from.
async function getDecision(runtime: CortexRuntime, args: { ids: string[] }) {
	const ids = [...new Set(args.ids)];
	const found = ids.flatMap((id) => runtime.nodes.getById(id) ?? []);
	const missing = ids.filter((id) => !found.some((node) => node.id === id));
	const anchors = await anchorsByDecision(runtime, found);
	const links = runtime.edges.listVersionedLinks(found.map((node) => node.id));
	runtime.usefulness.used(found.map((node) => node.id));
	return jsonResult({
		decisions: found.map((decision) =>
			fullEntry(decision, anchors.get(decision.id), links.get(decision.id)),
		),
		...(missing.length > 0
			? {
					not_found: missing,
					guidance:
						"Some ids are not in this project's store. Take ids from " +
						"get_context or search, or pass the projectPath they belong to.",
				}
			: {}),
	});
}

function fullEntry(
	decision: Decision,
	anchors: Parameters<typeof anchorEntries>[0],
	links: VersionedLinks | undefined,
) {
	return {
		id: decision.id,
		title: decision.title,
		status: decision.status,
		...(decision.present ? {} : { present: false }),
		module: decision.module,
		keywords: decision.keywords,
		body: decision.body,
		...(anchors && anchors.length > 0
			? { anchors: anchorEntries(anchors) }
			: {}),
		...nonEmpty("depends_on", links?.dependsOn),
		...nonEmpty("replaces", links?.replaces),
		...nonEmpty("replaced_by", links?.replacedBy),
		...nonEmpty("archives", links?.archives),
		...nonEmpty("archived_by", links?.archivedBy),
		provenance: decision.provenance,
		createdAt: decision.createdAt,
	};
}

function nonEmpty(key: string, values: string[] | undefined) {
	return values && values.length > 0 ? { [key]: values } : {};
}
