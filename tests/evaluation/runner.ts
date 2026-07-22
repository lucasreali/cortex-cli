#!/usr/bin/env bun
import { buildRuntimeAt, type CortexRuntime } from "@/app/runtime";
import { printJson } from "@/cli/json";
import { failure, style, warning } from "@/cli/style";
import type { EmbeddingProvider } from "@/embedding/provider";
import { findNearestCortexRoot } from "@/storage/locate-store";
import { type EvalCase, GROUND_TRUTH } from "./ground-truth";
import { meanScore, type RankingScore, scoreRanking } from "./scoring";
import { buildStrategies, type SearchStrategy } from "./strategies";

const TOP_K = 5;

interface StrategyOutcome extends RankingScore {
	ranked: string[];
	latencyMs: number;
}

interface CaseOutcome {
	evalCase: EvalCase;
	byStrategy: Record<string, StrategyOutcome>;
}

interface StrategySummary extends RankingScore {
	name: string;
	meanLatencyMs: number;
	zeroRecallCases: string[];
}

interface EvalReport {
	root: string;
	modelId: string;
	topK: number;
	cases: number;
	warmupMs: number;
	summaries: StrategySummary[];
	uncoveredDecisionIds: string[];
	outcomes: Array<{
		id: string;
		query: string;
		expected: string[];
		results: Record<string, StrategyOutcome>;
	}>;
}

async function main(): Promise<number> {
	const root = findNearestCortexRoot(process.cwd());
	if (!root) {
		console.error(
			failure("no .cortex store found above the current directory"),
		);
		return 1;
	}
	const runtime = await buildRuntimeAt(root);
	try {
		return await evaluate(runtime, root, process.argv.includes("--json"));
	} finally {
		runtime.dispose();
	}
}

async function evaluate(
	runtime: CortexRuntime,
	root: string,
	json: boolean,
): Promise<number> {
	const provider = runtime.provider;
	if (!provider) {
		console.error(
			failure(
				"the eval needs the real embedding model; unset CORTEX_DISABLE_EMBEDDINGS",
			),
		);
		return 1;
	}
	const problems = validateGroundTruth(runtime);
	if (problems.length > 0) {
		for (const problem of problems) console.error(failure(problem));
		return 1;
	}
	const report = await measure(runtime, provider, root);
	if (json) printJson(report);
	else printHuman(report, runtime);
	return 0;
}

function validateGroundTruth(runtime: CortexRuntime): string[] {
	return GROUND_TRUTH.flatMap((evalCase) =>
		evalCase.expected.flatMap((id) => caseProblem(runtime, evalCase.id, id)),
	);
}

function caseProblem(
	runtime: CortexRuntime,
	caseId: string,
	decisionId: string,
): string[] {
	const decision = runtime.nodes.getById(decisionId);
	if (!decision) return [`case ${caseId}: unknown decision id ${decisionId}`];
	if (decision.status !== "active")
		return [`case ${caseId}: decision ${decisionId} is ${decision.status}`];
	return [];
}

async function measure(
	runtime: CortexRuntime,
	provider: EmbeddingProvider,
	root: string,
): Promise<EvalReport> {
	const warmupStart = performance.now();
	await provider.embedQuery("warmup");
	const warmupMs = performance.now() - warmupStart;
	const strategies = buildStrategies({
		nodes: runtime.nodes,
		fts: runtime.fts,
		embeddings: runtime.embeddings,
		semanticSearch: runtime.semanticSearch,
		provider,
	});
	const outcomes: CaseOutcome[] = [];
	for (const evalCase of GROUND_TRUTH) {
		outcomes.push(await runCase(strategies, evalCase));
	}
	return {
		root,
		modelId: provider.modelId,
		topK: TOP_K,
		cases: GROUND_TRUTH.length,
		warmupMs,
		summaries: strategies.map((strategy) => summarize(strategy.name, outcomes)),
		uncoveredDecisionIds: uncoveredDecisionIds(runtime),
		outcomes: outcomes.map((outcome) => ({
			id: outcome.evalCase.id,
			query: outcome.evalCase.query,
			expected: outcome.evalCase.expected,
			results: outcome.byStrategy,
		})),
	};
}

async function runCase(
	strategies: SearchStrategy[],
	evalCase: EvalCase,
): Promise<CaseOutcome> {
	const byStrategy: Record<string, StrategyOutcome> = {};
	for (const strategy of strategies) {
		const start = performance.now();
		const ranked = await strategy.run(evalCase.query, TOP_K);
		const latencyMs = performance.now() - start;
		byStrategy[strategy.name] = {
			ranked,
			latencyMs,
			...scoreRanking(evalCase.expected, ranked),
		};
	}
	return { evalCase, byStrategy };
}

function summarize(name: string, outcomes: CaseOutcome[]): StrategySummary {
	const results = outcomes.map((outcome) => strategyOutcome(outcome, name));
	const latencyTotal = results.reduce(
		(sum, result) => sum + result.latencyMs,
		0,
	);
	return {
		name,
		...meanScore(results),
		meanLatencyMs: latencyTotal / results.length,
		zeroRecallCases: outcomes
			.filter((outcome) => strategyOutcome(outcome, name).recall === 0)
			.map((outcome) => outcome.evalCase.id),
	};
}

function strategyOutcome(outcome: CaseOutcome, name: string): StrategyOutcome {
	const result = outcome.byStrategy[name];
	if (!result) throw new Error(`missing outcome for strategy ${name}`);
	return result;
}

function uncoveredDecisionIds(runtime: CortexRuntime): string[] {
	const referenced = new Set(
		GROUND_TRUTH.flatMap((evalCase) => evalCase.expected),
	);
	return runtime.nodes
		.listActive()
		.filter((decision) => !referenced.has(decision.id))
		.map((decision) => decision.id);
}

function printHuman(report: EvalReport, runtime: CortexRuntime): void {
	console.log(
		`${style.bold("cortex search eval")} ${style.dim(`— ${report.root}`)}`,
	);
	console.log(
		style.dim(
			`model ${report.modelId} | ${report.cases} cases | top-${report.topK} | warmup ${Math.round(report.warmupMs)}ms`,
		),
	);
	console.log("");
	printSummaries(report.summaries);
	printRegressions(report, runtime);
	printUncovered(report, runtime);
}

function printSummaries(summaries: StrategySummary[]): void {
	console.log(
		style.bold(
			`${"strategy".padEnd(9)}${"recall@5".padEnd(10)}${"mrr".padEnd(7)}${"avg ms".padEnd(8)}zero-recall`,
		),
	);
	for (const summary of summaries) {
		console.log(formatSummaryLine(summary));
		if (summary.zeroRecallCases.length > 0)
			console.log(
				style.dim(`         misses: ${summary.zeroRecallCases.join(", ")}`),
			);
	}
}

function formatSummaryLine(summary: StrategySummary): string {
	const recall = summary.recall.toFixed(3).padEnd(10);
	const mrr = summary.reciprocalRank.toFixed(3).padEnd(7);
	const latency = summary.meanLatencyMs.toFixed(1).padEnd(8);
	const misses = String(summary.zeroRecallCases.length);
	return `${summary.name.padEnd(9)}${recall}${mrr}${latency}${misses}`;
}

function printRegressions(report: EvalReport, runtime: CortexRuntime): void {
	const regressed = report.outcomes.filter(
		(outcome) => (outcome.results.current?.recall ?? 0) < 1,
	);
	console.log("");
	if (regressed.length === 0) {
		console.log(style.dim("current hits every expected id."));
		return;
	}
	console.log(style.bold("cases where current misses expected ids:"));
	for (const outcome of regressed) {
		printRegressedCase(outcome, runtime);
	}
}

function printRegressedCase(
	outcome: EvalReport["outcomes"][number],
	runtime: CortexRuntime,
): void {
	const current = outcome.results.current?.recall.toFixed(2);
	const fts = outcome.results.fts?.recall.toFixed(2);
	const vector = outcome.results.vector?.recall.toFixed(2);
	console.log(
		`  ${outcome.id.padEnd(22)} current ${current}  (fts ${fts}, vector ${vector})`,
	);
	console.log(style.dim(`    "${outcome.query}"`));
	for (const id of outcome.expected) {
		console.log(style.dim(`    expects ${shortTitle(runtime, id)}`));
	}
}

function printUncovered(report: EvalReport, runtime: CortexRuntime): void {
	if (report.uncoveredDecisionIds.length === 0) return;
	console.log("");
	console.log(
		warning(
			`${report.uncoveredDecisionIds.length} active decisions have no ground-truth case:`,
		),
	);
	for (const id of report.uncoveredDecisionIds) {
		console.log(style.dim(`  ${shortTitle(runtime, id)}`));
	}
}

function shortTitle(runtime: CortexRuntime, id: string): string {
	const title = runtime.nodes.getById(id)?.title ?? "?";
	return `${id.slice(0, 13)} ${title}`;
}

process.exit(await main());
