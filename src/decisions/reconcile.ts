import type { DecisionFile } from "@/domain";
import type {
	DecisionPresence,
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
	edited: string[];
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
	contentShas: Map<string, string>;
	malformed: MalformedDecisionFile[];
	malformedIds: string[];
}

// Drift is a set difference plus one fingerprint per present file. Decision
// files are meant to be immutable — changing your mind writes a new file with
// `replaces` — but they are markdown on a branch, and a hand edit or a merge
// that resolved a conflict inside one used to leave the row, its anchors, its
// FTS entry and its vector describing text that no longer existed anywhere.
export function reconcileDecisions(
	dependencies: ReconcileDependencies,
	options: ReconcileOptions = {},
): ReconcileReport {
	const listing = dependencies.store.list();
	if (!listing.ok) return quiet([unreadableDirectory(listing.reason)]);
	const onDisk = new Set(listing.ids);
	const stored = dependencies.repository.listPresence();
	const storedIds = new Set(stored.map((entry) => entry.id));
	const arriving = [...onDisk].filter((id) => !storedIds.has(id));
	const absent = stored
		.filter((entry) => entry.present && !onDisk.has(entry.id))
		.map((entry) => entry.id);
	const restored = stored
		.filter((entry) => !entry.present && onDisk.has(entry.id))
		.map((entry) => entry.id);
	const drift = { arriving, absent, restored };

	if (!options.full) {
		const arrivals = parseAll(dependencies, arriving);
		const edits = parseAll(
			dependencies,
			changedOnDisk(dependencies, stored, onDisk),
		);
		if (nothingMoves(arrivals, edits, drift)) {
			return quiet([
				...arrivals.malformed,
				...edits.malformed,
				...listing.unusable,
			]);
		}
	}
	return apply(dependencies, drift, listing, stored);
}

// One read and one hash per present file, no parse: what the cheap path pays
// to notice an edit. A row derived before the fingerprint existed has none, so
// it counts as changed exactly once and is rewritten from its file.
function changedOnDisk(
	dependencies: ReconcileDependencies,
	stored: DecisionPresence[],
	onDisk: Set<string>,
): string[] {
	return stored
		.filter((entry) => onDisk.has(entry.id))
		.filter((entry) => dependencies.store.digest(entry.id) !== entry.contentSha)
		.map((entry) => entry.id);
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
// the whole edge table on an ordinary read. Parsing the arrivals and the edits
// is what the cheap path pays to stay cheap, and when there are none it costs
// nothing.
function nothingMoves(
	arrivals: ParsedFiles,
	edits: ParsedFiles,
	drift: Drift,
): boolean {
	return (
		arrivals.files.length +
			edits.files.length +
			drift.absent.length +
			drift.restored.length ===
		0
	);
}

function quiet(malformed: MalformedDecisionFile[]): ReconcileReport {
	return {
		imported: [],
		edited: [],
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
	stored: DecisionPresence[],
): ReconcileReport {
	const parsed = parseAll(dependencies, listing.ids);
	const usable = new Map(parsed.files.map((file) => [file.id, file]));
	const storedShas = new Map(
		stored.map((entry) => [entry.id, entry.contentSha]),
	);
	const arrivals = drift.arriving
		.filter((id) => usable.has(id))
		.map((id) => usable.get(id) as DecisionFile);
	const edits = parsed.files.filter(
		(file) =>
			storedShas.has(file.id) &&
			storedShas.get(file.id) !== parsed.contentShas.get(file.id),
	);
	const known = new Set([...storedShas.keys(), ...usable.keys()]);
	const preserved = dependencies.repository.listEdgesOwnedBy(
		parsed.malformedIds.filter((id) => storedShas.has(id)),
	);
	const links = deriveLinks(parsed.files, preserved, known);

	const writes = dependencies.repository.transaction(() => {
		const insertion = insertArrivals(dependencies.repository, arrivals, parsed);
		const update = updateEdits(dependencies.repository, edits, parsed);
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
		return { insertion, update };
	});

	return {
		imported: writes.insertion.written,
		edited: writes.update.written,
		absent: drift.absent,
		restored: drift.restored,
		dangling: links.dangling,
		cyclic: links.cyclic,
		multiplyReplaced: supersededTwice(parsed.files),
		malformed: [
			...parsed.malformed,
			...writes.insertion.refused,
			...writes.update.refused,
			...listing.unusable,
		],
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

interface Writes {
	written: string[];
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
	parsed: ParsedFiles,
): Writes {
	return eachRefusable(files, (file) =>
		repository.insertDecision(
			file,
			null,
			parsed.contentShas.get(file.id) ?? null,
		),
	);
}

function updateEdits(
	repository: DecisionSyncRepository,
	files: DecisionFile[],
	parsed: ParsedFiles,
): Writes {
	return eachRefusable(files, (file) =>
		repository.updateDecision(file, parsed.contentShas.get(file.id) as string),
	);
}

function eachRefusable(
	files: DecisionFile[],
	write: (file: DecisionFile) => void,
): Writes {
	const written: string[] = [];
	const refused: MalformedDecisionFile[] = [];
	for (const file of files) {
		try {
			write(file);
			written.push(file.id);
		} catch (error) {
			refused.push({ name: `${file.id}.md`, reason: errorMessage(error) });
		}
	}
	return { written, refused };
}

// A file that exists but does not parse is present-but-unusable, never absent:
// one typo in a hand-edited file must not silently drop a decision out of
// search. Its node keeps the presence, the content and the edges it already had.
function parseAll(
	dependencies: ReconcileDependencies,
	ids: string[],
): ParsedFiles {
	const files: DecisionFile[] = [];
	const contentShas = new Map<string, string>();
	const malformed: MalformedDecisionFile[] = [];
	const malformedIds: string[] = [];
	for (const id of ids) {
		const read = dependencies.store.read(id);
		if (read.ok) {
			files.push(read.file);
			contentShas.set(id, read.contentSha);
		} else {
			malformed.push({ name: `${id}.md`, reason: read.reason });
			malformedIds.push(id);
		}
	}
	return { files, contentShas, malformed, malformedIds };
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
function deriveLinks(
	files: DecisionFile[],
	preserved: VersionedEdge[],
	known: Set<string>,
): DerivedLinks {
	const resolved: VersionedEdge[] = [];
	const dangling: VersionedEdge[] = [];
	for (const edge of [...files.flatMap(edgesOf), ...preserved]) {
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
