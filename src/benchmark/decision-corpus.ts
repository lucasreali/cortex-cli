import { TokenCount } from "./token-count";

export interface CorpusEntry {
	id: string;
	text: string;
}

// What reading every recorded decision costs, and what reading a named few
// costs. The baseline the benchmark compares against is the whole of it: an
// agent with no retrieval either reads all of this or guesses.
export class DecisionCorpus {
	private readonly byId: Map<string, TokenCount>;

	constructor(entries: CorpusEntry[]) {
		this.byId = new Map(
			entries.map((entry) => [entry.id, TokenCount.of(entry.text)]),
		);
	}

	get decisions(): number {
		return this.byId.size;
	}

	get total(): TokenCount {
		return TokenCount.sum([...this.byId.values()]);
	}

	// An id the corpus does not hold costs nothing rather than throwing: a
	// result can name a decision whose file this branch does not carry, and a
	// benchmark must not die on it.
	tokensOf(ids: string[]): TokenCount {
		return TokenCount.sum(
			ids.map((id) => this.byId.get(id) ?? TokenCount.zero()),
		);
	}
}
