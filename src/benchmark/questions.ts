export interface DecisionHeading {
	id: string;
	title: string;
}

export interface BenchmarkQuestion {
	id: string;
	query: string;
	expected: string;
}

// The sample questions are the corpus asking about itself: one per active
// decision, its own title, ordered by id. Fixed for a given corpus and
// available in any project, where a hand-written list would only ever fit the
// repository it was written for. The retrieval quality this yields is an upper
// bound — a title is a friendlier query than a person's question — which is
// why the hit rate is reported beside the economy rather than instead of it,
// and why the graded PT/EN paraphrases in tests/evaluation stay the authority
// on recall.
export function questionsFromDecisions(
	decisions: DecisionHeading[],
	limit: number | null,
): BenchmarkQuestion[] {
	const questions = [...decisions]
		.sort((left, right) => left.id.localeCompare(right.id))
		.map((decision) => ({
			id: decision.id,
			query: decision.title,
			expected: decision.id,
		}));
	if (limit === null) return questions;
	return questions.slice(0, Math.max(0, limit));
}
