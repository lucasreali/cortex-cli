import type { DecisionFile } from "@/domain";
import type {
	DecisionSyncRepository,
	VersionedEdgeKind,
} from "@/storage/decision-sync-repository";
import type { DecisionStore } from "./decision-store";

export interface ReconcileDependencies {
	store: DecisionStore;
	repository: DecisionSyncRepository;
}

export interface ReconcileOptions {
	// Recompute edges and statuses even when the set of present files did not
	// change. The cheap path trusts that decision files are immutable; a
	// diagnostic must not.
	full?: boolean;
}

export interface VersionedEdge {
	from: string;
	kind: VersionedEdgeKind;
	to: string;
}

export interface MalformedDecisionFile {
	name: string;
	reason: string;
}

export interface SupersededTwice {
	target: string;
	by: string[];
}

export interface ReconcileReport {
	imported: string[];
	absent: string[];
	restored: string[];
	dangling: VersionedEdge[];
	multiplyReplaced: SupersededTwice[];
	malformed: MalformedDecisionFile[];
}

interface ParsedFiles {
	files: DecisionFile[];
	malformed: MalformedDecisionFile[];
}

// Drift detection is a set difference — no stamp, no hash, no mtime — because
// a decision file is immutable: changing your mind writes a new file with
// `replaces`, and nothing ever rewrites an existing one.
export function reconcileDecisions(
	dependencies: ReconcileDependencies,
	options: ReconcileOptions = {},
): ReconcileReport {
	const onDisk = new Set(dependencies.store.listIds());
	const stored = dependencies.repository.listPresence();
	const arriving = [...onDisk].filter(
		(id) => !stored.some((entry) => entry.id === id),
	);
	const absent = stored
		.filter((entry) => entry.present && !onDisk.has(entry.id))
		.map((entry) => entry.id);
	const restored = stored
		.filter((entry) => !entry.present && onDisk.has(entry.id))
		.map((entry) => entry.id);

	if (
		!options.full &&
		arriving.length + absent.length + restored.length === 0
	) {
		return quiet();
	}
	return apply(
		dependencies,
		{ arriving, absent, restored },
		[...onDisk],
		stored,
	);
}

function quiet(): ReconcileReport {
	return {
		imported: [],
		absent: [],
		restored: [],
		dangling: [],
		multiplyReplaced: [],
		malformed: [],
	};
}

interface Drift {
	arriving: string[];
	absent: string[];
	restored: string[];
}

function apply(
	dependencies: ReconcileDependencies,
	drift: Drift,
	onDisk: string[],
	stored: Array<{ id: string }>,
): ReconcileReport {
	const parsed = parseAll(dependencies, onDisk);
	const usable = new Map(parsed.files.map((file) => [file.id, file]));
	const imported = drift.arriving.filter((id) => usable.has(id));
	const known = new Set([...stored.map((entry) => entry.id), ...usable.keys()]);
	const links = deriveLinks(parsed.files, known);

	dependencies.repository.transaction(() => {
		for (const id of imported) {
			dependencies.repository.insertDecision(
				usable.get(id) as DecisionFile,
				null,
			);
		}
		dependencies.repository.setPresent(drift.absent, false);
		dependencies.repository.setPresent(drift.restored, true);
		dependencies.repository.clearVersionedEdges();
		for (const edge of links.edges) {
			dependencies.repository.insertVersionedEdge(
				edge.from,
				edge.kind,
				edge.to,
			);
		}
		dependencies.repository.applyStatuses(links.replaced);
	});

	return {
		imported,
		absent: drift.absent,
		restored: drift.restored,
		dangling: links.dangling,
		multiplyReplaced: supersededTwice(parsed.files),
		malformed: [...parsed.malformed, ...unnamed(dependencies)],
	};
}

// A file that exists but does not parse is present-but-unusable, never absent:
// one typo in a hand-edited file must not silently drop a decision out of
// search. Its node keeps the presence it already had.
function parseAll(
	dependencies: ReconcileDependencies,
	ids: string[],
): ParsedFiles {
	const files: DecisionFile[] = [];
	const malformed: MalformedDecisionFile[] = [];
	for (const id of ids) {
		const parse = dependencies.store.read(id);
		if (parse.ok) files.push(parse.file);
		else malformed.push({ name: `${id}.md`, reason: parse.reason });
	}
	return { files, malformed };
}

function unnamed(dependencies: ReconcileDependencies): MalformedDecisionFile[] {
	return dependencies.store
		.listUnparseableNames()
		.map((name) => ({ name, reason: "filename is not a decision id" }));
}

interface DerivedLinks {
	edges: VersionedEdge[];
	dangling: VersionedEdge[];
	replaced: string[];
}

// Targets are checked against the store, not the branch: nothing is ever
// deleted, so a depends_on naming a decision that lives only on another branch
// still resolves. A target that is nowhere is skipped rather than inserted —
// foreign keys are on, and a bad edge would fail every command.
function deriveLinks(files: DecisionFile[], known: Set<string>): DerivedLinks {
	const edges: VersionedEdge[] = [];
	const dangling: VersionedEdge[] = [];
	const replaced = new Set<string>();
	for (const edge of files.flatMap(edgesOf)) {
		if (!known.has(edge.from) || !known.has(edge.to)) {
			dangling.push(edge);
			continue;
		}
		edges.push(edge);
		if (edge.kind === "REPLACED_BY") replaced.add(edge.from);
	}
	return { edges, dangling, replaced: [...replaced] };
}

// `replaces` lives on the new decision's file — that is what keeps files
// write-once — but the edge points the other way, from the superseded decision
// to its replacement, so either endpoint may be the one that is missing.
function edgesOf(file: DecisionFile): VersionedEdge[] {
	const supersedes: VersionedEdge[] = file.replaces
		? [{ from: file.replaces, kind: "REPLACED_BY", to: file.id }]
		: [];
	return [
		...file.dependsOn.map(
			(target): VersionedEdge => ({
				from: file.id,
				kind: "DEPENDS_ON",
				to: target,
			}),
		),
		...file.conflictsWith.map(
			(target): VersionedEdge => ({
				from: file.id,
				kind: "CONFLICTS_WITH",
				to: target,
			}),
		),
		...supersedes,
	];
}

// Two branches superseding the same decision both merge cleanly and both facts
// are true, so this is reported rather than resolved.
function supersededTwice(files: DecisionFile[]): SupersededTwice[] {
	const by = new Map<string, string[]>();
	for (const file of files.filter((entry) => entry.replaces !== null)) {
		const target = file.replaces as string;
		by.set(target, [...(by.get(target) ?? []), file.id]);
	}
	return [...by]
		.filter(([, replacements]) => replacements.length > 1)
		.map(([target, replacements]) => ({ target, by: replacements }));
}
