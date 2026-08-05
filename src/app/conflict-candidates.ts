import type { CreateDecisionInput, Decision } from "@/domain";
import type { CortexRuntime } from "./runtime";

export interface ConflictCandidate {
	id: string;
	title: string;
	module: string | null;
	reason: string;
}

const MINIMUM_OVERLAP = 2;
const CANDIDATE_LIMIT = 3;
const FTS_POOL_LIMIT = 20;
const MINIMUM_TERM_LENGTH = 3;

type ConflictDependencies = Pick<CortexRuntime, "nodes" | "fts">;

interface ScoredCandidate {
	decision: Decision;
	shared: string[];
	ftsRank: number | null;
}

// Suggestion only, computed before the save so the pool cannot contain the
// new decision. Embeddings stay off the save path by design — the signals are
// keyword overlap and FTS, which answer even when vectors are absent.
export function conflictCandidates(
	runtime: ConflictDependencies,
	input: CreateDecisionInput,
): ConflictCandidate[] {
	const linked = linkedIds(input);
	const ranks = ftsRanks(runtime, input);
	return runtime.nodes
		.listActive(input.module ? { module: input.module } : {})
		.filter((decision) => !linked.has(decision.id))
		.map((decision) => score(decision, input, ranks))
		.filter((candidate) => qualifies(candidate, input.module !== undefined))
		.sort(byRelevance)
		.slice(0, CANDIDATE_LIMIT)
		.map(toCandidate);
}

function linkedIds(input: CreateDecisionInput): Set<string> {
	return new Set([
		...(input.depends_on ?? []),
		...(input.conflicts_with ?? []),
		...(input.replaces ? [input.replaces] : []),
	]);
}

function ftsRanks(
	runtime: ConflictDependencies,
	input: CreateDecisionInput,
): Map<string, number> {
	const terms = [...input.keywords, ...titleTerms(input.title)];
	const hits = runtime.fts.searchExact(terms, FTS_POOL_LIMIT);
	return new Map(hits.map((hit) => [hit.nodeId, hit.rank]));
}

function titleTerms(title: string): string[] {
	return title
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((term) => term.length >= MINIMUM_TERM_LENGTH);
}

function score(
	decision: Decision,
	input: CreateDecisionInput,
	ftsRanks: Map<string, number>,
): ScoredCandidate {
	const incoming = new Set(
		input.keywords.map((keyword) => keyword.toLowerCase()),
	);
	const shared = decision.keywords.filter((keyword) =>
		incoming.has(keyword.toLowerCase()),
	);
	return { decision, shared, ftsRank: ftsRanks.get(decision.id) ?? null };
}

// Without a module fence the pool is the whole store, so both signals must
// agree before a decision is flagged.
function qualifies(candidate: ScoredCandidate, sameModule: boolean): boolean {
	const overlaps = candidate.shared.length >= MINIMUM_OVERLAP;
	if (!sameModule) return overlaps && candidate.ftsRank !== null;
	return (
		overlaps || (candidate.ftsRank !== null && candidate.shared.length >= 1)
	);
}

// bm25 ranks are negative-is-better; a candidate FTS never saw goes last.
function byRelevance(a: ScoredCandidate, b: ScoredCandidate): number {
	if (a.shared.length !== b.shared.length) {
		return b.shared.length - a.shared.length;
	}
	return (a.ftsRank ?? 0) - (b.ftsRank ?? 0);
}

function toCandidate(candidate: ScoredCandidate): ConflictCandidate {
	return {
		id: candidate.decision.id,
		title: candidate.decision.title,
		module: candidate.decision.module,
		reason: reasonOf(candidate),
	};
}

function reasonOf(candidate: ScoredCandidate): string {
	const parts = [];
	if (candidate.shared.length > 0) {
		parts.push(`shares keywords: ${candidate.shared.join(", ")}`);
	}
	if (candidate.ftsRank !== null) {
		parts.push("full-text match on title/keywords");
	}
	return parts.join("; ");
}
