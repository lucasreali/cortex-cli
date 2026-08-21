import { TokenCount } from "./token-count";

export interface RepositoryFile {
	path: string;
	text: string;
}

export interface GrepCost {
	files: number;
	tokens: TokenCount;
}

export interface GrepCosts {
	best: GrepCost;
	median: GrepCost;
}

interface IndexedFile {
	haystack: string;
	tokens: TokenCount;
}

// The alternative cortex claims to replace: grep the repository for a word
// from the question and read what comes back. Matching is a case-insensitive
// substring over the whole file, as `grep -il` does, across everything git
// would not ignore — tracked or merely untracked-and-not-ignored, which is the
// working tree a person greps.
//
// One term at a time, never their union: half the words in any question are
// connectives that match nearly every file, and charging their union would
// measure the stopwords rather than the search. Two single greps are reported
// instead — the most selective term the question offers, which is the floor of
// this alternative and the number the comparison should be judged on, and the
// median term, which is what one unlucky-but-ordinary keyword costs.
export class RepositoryCorpus {
	private readonly indexed: IndexedFile[];

	constructor(files: RepositoryFile[]) {
		this.indexed = files.map((file) => ({
			haystack: file.text.toLowerCase(),
			tokens: TokenCount.of(file.text),
		}));
	}

	get files(): number {
		return this.indexed.length;
	}

	get total(): TokenCount {
		return TokenCount.sum(this.indexed.map((file) => file.tokens));
	}

	grepCosts(terms: string[]): GrepCosts {
		const costs = terms
			.map((term) => this.costOf(term))
			.filter((cost) => cost.files > 0)
			.sort(byNarrowness);
		return {
			best: costs.at(0) ?? emptyCost(),
			median: costs.at(Math.floor(costs.length / 2)) ?? emptyCost(),
		};
	}

	private costOf(term: string): GrepCost {
		const matched = this.indexed.filter((file) =>
			file.haystack.includes(term.toLowerCase()),
		);
		return {
			files: matched.length,
			tokens: TokenCount.sum(matched.map((file) => file.tokens)),
		};
	}
}

// Narrowest means the fewest files, which is the term a person greping would
// pick and what the report has always claimed this number is; sorting by tokens
// answered a different question, and the file count printed beside it was then
// not the smallest one. Two terms matching the same number of files are ordered
// by what those files cost to read.
function byNarrowness(left: GrepCost, right: GrepCost): number {
	return left.files - right.files || left.tokens.total - right.tokens.total;
}

function emptyCost(): GrepCost {
	return { files: 0, tokens: TokenCount.zero() };
}
