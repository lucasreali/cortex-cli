import type {
	Anchor,
	AnchorInput,
	CreateDecisionInput,
	DecisionFile,
} from "@/domain";
import type { SaveContext } from "@/storage/node-repository";
import {
	type ReconcileDependencies,
	type ReconcileReport,
	reconcileDecisions,
} from "./reconcile";

export interface SavedDecision {
	id: string;
	report: ReconcileReport;
}

// The file is written before the row, because the file is the product: if the
// database work below fails, the next reconcile imports what is already on
// disk — losing only the session link, which is local anyway.
//
// Nothing here derives status or versioned edges: that is reconcile's job, and
// running it means a decision saved on this machine goes through exactly the
// same derivation as one that arrived from someone else's branch.
export function saveDecisionFile(
	dependencies: ReconcileDependencies,
	input: CreateDecisionInput,
	context: SaveContext,
): SavedDecision {
	const file = toDecisionFile(input, context);
	dependencies.store.write(file);
	dependencies.repository.insertDecision(file, {
		projectId: context.projectId,
		sessionId: context.sessionId,
	});
	return {
		id: file.id,
		report: reconcileDecisions(dependencies, { full: true }),
	};
}

function toDecisionFile(
	input: CreateDecisionInput,
	context: SaveContext,
): DecisionFile {
	return {
		id: Bun.randomUUIDv7(),
		title: input.title,
		body: input.body,
		keywords: input.keywords,
		module: input.module ?? null,
		replaces: input.replaces ?? null,
		archives: input.archives ?? null,
		dependsOn: input.depends_on ?? [],
		conflictsWith: input.conflicts_with ?? [],
		anchors: (input.anchors ?? []).map(toAnchor),
		commitSha: context.commitSha,
		commitDirty: context.commitDirty,
		provenance: context.provenance ?? "agent",
		createdAt: new Date().toISOString(),
	};
}

function toAnchor(input: AnchorInput): Anchor {
	return { filePath: input.file_path, symbol: input.symbol ?? "" };
}
