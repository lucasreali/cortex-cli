// No tokenizer for the model that will read these decisions is available in
// process — the one cortex ships is the embedding model's, and an agent reads
// with its own — so this counts tokens by a deterministic rule instead. It is
// calibrated against that SentencePiece tokenizer over this repository's
// markdown and TypeScript (181 files, 126k tokens): 1.03x its total, 0.83x to
// 1.21x on any single file. The economy figures divide one count by another,
// so a proportional estimator answers the same question an exact one would.
export const TOKEN_METHOD = {
	id: "atoms-per-5-bytes/v1",
	description:
		"split into atoms (a letter run, up to three digits, or one punctuation " +
		"character, each carrying the whitespace before it) and charge every " +
		"atom round(utf8 bytes / 5) tokens, minimum one",
} as const;

const ATOM = /\s*[\p{L}\p{M}]+|\s*\p{N}{1,3}|\s*[^\s\p{L}\p{N}\p{M}]|\s+/gu;

const BYTES_PER_TOKEN = 5;

const ENCODER = new TextEncoder();

export class TokenCount {
	private constructor(readonly total: number) {}

	static of(text: string): TokenCount {
		const atoms = text.match(ATOM) ?? [];
		return new TokenCount(atoms.reduce(addAtomCost, 0));
	}

	static zero(): TokenCount {
		return new TokenCount(0);
	}

	static sum(counts: TokenCount[]): TokenCount {
		return counts.reduce((left, right) => left.plus(right), TokenCount.zero());
	}

	plus(other: TokenCount): TokenCount {
		return new TokenCount(this.total + other.total);
	}

	// A ratio against nothing is not "infinitely better", it is unmeasured.
	ratioTo(other: TokenCount): number {
		if (other.total === 0) return 0;
		return this.total / other.total;
	}
}

function addAtomCost(carried: number, atom: string): number {
	return carried + Math.max(1, Math.round(byteLength(atom) / BYTES_PER_TOKEN));
}

function byteLength(atom: string): number {
	return ENCODER.encode(atom).length;
}
