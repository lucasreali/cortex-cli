import type { DecisionCorpus } from "./decision-corpus";
import type { BenchmarkQuestion } from "./questions";
import type { RepositoryCorpus } from "./repository-corpus";
import { TOKEN_METHOD } from "./token-count";

export interface RetrievalPath {
	name: string;
	retrieve(query: string): Promise<string[]>;
	termsOf(query: string): string[];
}

export interface BenchmarkCorpora {
	decisions: DecisionCorpus;
	repository: RepositoryCorpus;
}

export interface CostEntry {
	files: number;
	tokens: number;
}

export interface QuestionMeasurement {
	id: string;
	query: string;
	answered: number;
	answerTokens: number;
	grepBest: CostEntry;
	grepMedian: CostEntry;
	hit: boolean;
}

// Every question is the decision's own title, so a hit only says the decision
// is retrievable by its own words — the friendliest query it will ever get.
// The caveat travels with the number so that no surface can print the rate
// without it; before, only the markdown carried it.
export const HIT_RATE_CAVEAT =
	"the question is the decision's own title, so this is a ceiling on " +
	"retrieval, not a measurement of it";

export interface BenchmarkReport {
	project: string;
	method: { id: string; description: string };
	retrieval: string;
	questions: number;
	corpus: { decisions: number; tokens: number };
	repository: { files: number; tokens: number };
	answer: { meanDecisions: number; meanTokens: number };
	grepBest: { meanFiles: number; meanTokens: number };
	grepMedian: { meanFiles: number; meanTokens: number };
	economy: {
		corpusPerAnswer: number | null;
		grepBestPerAnswer: number | null;
		grepMedianPerAnswer: number | null;
	};
	hitRate: number;
	hitRateCaveat: string;
	cases: QuestionMeasurement[];
}

export async function measureBenchmark(
	project: string,
	questions: BenchmarkQuestion[],
	corpora: BenchmarkCorpora,
	retrieval: RetrievalPath,
): Promise<BenchmarkReport> {
	const cases: QuestionMeasurement[] = [];
	for (const question of questions) {
		cases.push(await measureQuestion(question, corpora, retrieval));
	}
	const answerTokens = mean(cases.map((one) => one.answerTokens));
	const best = meanCost(cases.map((one) => one.grepBest));
	const median = meanCost(cases.map((one) => one.grepMedian));
	return {
		project,
		method: { ...TOKEN_METHOD },
		retrieval: retrieval.name,
		questions: cases.length,
		corpus: {
			decisions: corpora.decisions.decisions,
			tokens: corpora.decisions.total.total,
		},
		repository: {
			files: corpora.repository.files,
			tokens: corpora.repository.total.total,
		},
		answer: {
			meanDecisions: mean(cases.map((one) => one.answered)),
			meanTokens: answerTokens,
		},
		grepBest: best,
		grepMedian: median,
		economy: {
			corpusPerAnswer: ratio(corpora.decisions.total.total, answerTokens),
			grepBestPerAnswer: ratio(best.meanTokens, answerTokens),
			grepMedianPerAnswer: ratio(median.meanTokens, answerTokens),
		},
		hitRate: mean(cases.map((one) => (one.hit ? 1 : 0))),
		hitRateCaveat: HIT_RATE_CAVEAT,
		cases,
	};
}

async function measureQuestion(
	question: BenchmarkQuestion,
	corpora: BenchmarkCorpora,
	retrieval: RetrievalPath,
): Promise<QuestionMeasurement> {
	const answered = await retrieval.retrieve(question.query);
	const grep = corpora.repository.grepCosts(retrieval.termsOf(question.query));
	return {
		id: question.id,
		query: question.query,
		answered: answered.length,
		answerTokens: corpora.decisions.tokensOf(answered).total,
		grepBest: { files: grep.best.files, tokens: grep.best.tokens.total },
		grepMedian: { files: grep.median.files, tokens: grep.median.tokens.total },
		hit: answered.includes(question.expected),
	};
}

function meanCost(costs: CostEntry[]): {
	meanFiles: number;
	meanTokens: number;
} {
	return {
		meanFiles: mean(costs.map((cost) => cost.files)),
		meanTokens: mean(costs.map((cost) => cost.tokens)),
	};
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Nothing rather than zero when there is nothing to divide by: a run that
// retrieved no text at all has no economy to report, and rendering that as
// `0.0x` read as cortex costing infinitely more than the alternative it beats.
function ratio(cost: number, answer: number): number | null {
	if (answer === 0) return null;
	return cost / answer;
}
