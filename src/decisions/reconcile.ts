import type { DecisionFile } from "@/domain";
import type {
	DecisionSyncRepository,
	VersionedEdgeKind,
} from "@/storage/decision-sync-repository";
import { DECISIONS_DIRECTORY } from "@/storage/project-root";
import { errorMessage } from "@/support/errors";
import { breaksPromptFence } from "@/support/prompt-fence";
import type {
	DecisionIndex,
	DecisionStore,
	UnusableDecisionFile,
} from "./decision-store";

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

export type MalformedDecisionFile = UnusableDecisionFile;

export interface SupersededTwice {
	target: string;
	by: string[];
}

export interface ReconcileReport {
	imported: string[];
	absent: string[];
	restored: string[];
	dangling: VersionedEdge[];
	cyclic: VersionedEdge[];
	multiplyReplaced: SupersededTwice[];
	malformed: MalformedDecisionFile[];
	fenceBreaking: string[];
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
	const listing = dependencies.store.list();
	if (!listing.ok) return quiet([unreadableDirectory(listing.reason)]);
	const onDisk = new Set(listing.ids);
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
	const drift = { arriving, absent, restored };

	if (!options.full) {
		const arrivals = parseAll(dependencies, arriving);
		if (nothingMoves(arrivals, drift)) {
			return quiet([...arrivals.malformed, ...listing.unusable]);
		}
	}
	return apply(dependencies, drift, listing, stored);
}

// The whole directory answering EACCES is not a branch without decisions: it
// is reported and nothing moves, because retiring every decision the store
// holds is the one outcome an unreadable listing must never produce.
function unreadableDirectory(reason: string): MalformedDecisionFile {
	return { name: DECISIONS_DIRECTORY, reason };
}

// A file that does not parse is never inserted, so it stays in `arriving` for
// as long as it sits there — and counting ids alone would then send every
// process that builds a runtime down the full path, clearing and re-deriving
// the whole edge table on an ordinary read. Parsing the arrivals is what the
// cheap path pays to stay cheap, and when there are none it costs nothing.
function nothingMoves(arrivals: ParsedFiles, drift: Drift): boolean {
	return (
		arrivals.files.length + drift.absent.length + drift.restored.length === 0
	);
}

function quiet(malformed: MalformedDecisionFile[]): ReconcileReport {
	return {
		imported: [],
		absent: [],
		restored: [],
		dangling: [],
		cyclic: [],
		multiplyReplaced: [],
		malformed,
		fenceBreaking: [],
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
	listing: DecisionIndex,
	stored: Array<{ id: string }>,
): ReconcileReport {
	const parsed = parseAll(dependencies, listing.ids);
	const usable = new Map(parsed.files.map((file) => [file.id, file]));
	const arrivals = drift.arriving
		.filter((id) => usable.has(id))
		.map((id) => usable.get(id) as DecisionFile);
	const known = new Set([...stored.map((entry) => entry.id), ...usable.keys()]);
	const links = deriveLinks(parsed.files, known);

	const insertion = dependencies.repository.transaction(() => {
		const outcome = insertArrivals(dependencies.repository, arrivals);
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
		dependencies.repository.applyStatuses(links.replaced, links.archived);
		return outcome;
	});

	return {
		imported: insertion.imported,
		absent: drift.absent,
		restored: drift.restored,
		dangling: links.dangling,
		cyclic: links.cyclic,
		multiplyReplaced: supersededTwice(parsed.files),
		malformed: [...parsed.malformed, ...insertion.refused, ...listing.unusable],
		fenceBreaking: fenceBreaking(parsed.files),
	};
}

// The prompt hook escapes this text before it ever reaches a prompt, so a file
// naming the closing tag is reported and still imported — it is readable, it is
// a decision, and refusing it would drop one from the branch over a string.
// What it is not is an accident, which is why every one of them is named:
// unreadable files arrive in bulk from a corrupt checkout and share a cause
// worth capping the list over, while each of these is a separate act to look at.
function fenceBreaking(files: DecisionFile[]): string[] {
	return files
		.filter((file) =>
			[file.title, file.body, file.module ?? ""].some(breaksPromptFence),
		)
		.map((file) => `${file.id}.md`);
}

interface Insertion {
	imported: string[];
	refused: MalformedDecisionFile[];
}

// A decision the store refuses is reported like an unreadable file and skipped,
// because letting it out would roll the whole reconcile back — and `arriving`
// is recomputed from the same files on every run, so the next command would
// fail identically, naming neither the file nor the reason. One bad file must
// not be able to take every command down until a human guesses which one it is.
function insertArrivals(
	repository: DecisionSyncRepository,
	files: DecisionFile[],
): Insertion {
	const imported: string[] = [];
	const refused: MalformedDecisionFile[] = [];
	for (const file of files) {
		try {
			repository.insertDecision(file, null);
			imported.push(file.id);
		} catch (error) {
			refused.push({ name: `${file.id}.md`, reason: errorMessage(error) });
		}
	}
	return { imported, refused };
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

interface DerivedLinks {
	edges: VersionedEdge[];
	dangling: VersionedEdge[];
	cyclic: VersionedEdge[];
	replaced: string[];
	archived: string[];
}

// Targets are checked against the store, not the branch: nothing is ever
// deleted, so a depends_on naming a decision that lives only on another branch
// still resolves. A target that is nowhere is skipped rather than inserted —
// foreign keys are on, and a bad edge would fail every command.
function deriveLinks(files: DecisionFile[], known: Set<string>): DerivedLinks {
	const resolved: VersionedEdge[] = [];
	const dangling: VersionedEdge[] = [];
	for (const edge of files.flatMap(edgesOf)) {
		if (known.has(edge.from) && known.has(edge.to)) resolved.push(edge);
		else dangling.push(edge);
	}
	return { dangling, ...acyclic(resolved) };
}

// Every retirement is derived from the same files on every run, so a cycle in
// them is not a transient state: two branches that each superseded the other's
// decision merge cleanly, and applying both retires both — the pair vanishes
// from search, get_context and prompt-hook with an empty report, and files are
// immutable, so there is no undo. Dropped and named instead, which leaves both
// decisions active until a human writes the one that settles it.
function acyclic(edges: VersionedEdge[]): Omit<DerivedLinks, "dangling"> {
	const retirements = successorsOf(edges.filter(isRetirement));
	const cyclic = edges.filter((edge) => closesCycle(edge, retirements));
	const sound = edges.filter((edge) => !cyclic.includes(edge));
	return {
		edges: sound,
		cyclic,
		replaced: retiredBy(sound, "REPLACED_BY"),
		archived: retiredBy(sound, "ARCHIVED_BY"),
	};
}

function retiredBy(edges: VersionedEdge[], kind: VersionedEdgeKind): string[] {
	const retired = edges
		.filter((edge) => edge.kind === kind)
		.map((edge) => edge.from);
	return [...new Set(retired)];
}

function isRetirement(edge: VersionedEdge): boolean {
	return edge.kind === "REPLACED_BY" || edge.kind === "ARCHIVED_BY";
}

// A self-edge of any kind is dropped, not only a retiring one: it states
// nothing, the schema now refuses it, and letting one reach the insert would
// roll the whole reconcile back on every command.
function closesCycle(
	edge: VersionedEdge,
	retirements: Map<string, string[]>,
): boolean {
	if (edge.from === edge.to) return true;
	return isRetirement(edge) && reaches(retirements, edge.to, edge.from);
}

function successorsOf(edges: VersionedEdge[]): Map<string, string[]> {
	const successors = new Map<string, string[]>();
	for (const edge of edges) {
		successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to]);
	}
	return successors;
}

function reaches(
	successors: Map<string, string[]>,
	start: string,
	target: string,
): boolean {
	const seen = new Set<string>();
	const pending = [start];
	while (pending.length > 0) {
		const node = pending.pop() as string;
		if (node === target) return true;
		if (seen.has(node)) continue;
		seen.add(node);
		pending.push(...(successors.get(node) ?? []));
	}
	return false;
}

// `replaces` and `archives` live on the new decision's file — that is what
// keeps files write-once — but their edges point the other way, from the
// retired decision to the one retiring it, so either endpoint may be the one
// that is missing.
function edgesOf(file: DecisionFile): VersionedEdge[] {
	const supersedes: VersionedEdge[] = file.replaces
		? [{ from: file.replaces, kind: "REPLACED_BY", to: file.id }]
		: [];
	const retires: VersionedEdge[] = file.archives
		? [{ from: file.archives, kind: "ARCHIVED_BY", to: file.id }]
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
		...retires,
	];
}

// Two branches retiring the same decision — by superseding it, archiving it,
// or one of each — both merge cleanly and both facts are true, so this is
// reported rather than resolved.
function supersededTwice(files: DecisionFile[]): SupersededTwice[] {
	const by = new Map<string, string[]>();
	for (const file of files) {
		for (const target of [file.replaces, file.archives]) {
			if (target === null) continue;
			by.set(target, [...(by.get(target) ?? []), file.id]);
		}
	}
	return [...by]
		.filter(([, retirements]) => retirements.length > 1)
		.map(([target, retirements]) => ({ target, by: retirements }));
}
