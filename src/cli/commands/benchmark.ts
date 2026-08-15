import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import { searchDecisions } from "@/app/search-decisions";
import { DecisionCorpus } from "@/benchmark/decision-corpus";
import { measureBenchmark, type RetrievalPath } from "@/benchmark/measure";
import { questionsFromDecisions } from "@/benchmark/questions";
import {
	type BenchmarkStamp,
	formatBenchmarkMarkdown,
	formatBenchmarkTable,
} from "@/benchmark/report";
import {
	RepositoryCorpus,
	type RepositoryFile,
} from "@/benchmark/repository-corpus";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { style, success } from "@/cli/style";
import { usageError } from "@/cli/usage";
import { DecisionStore } from "@/decisions/decision-store";
import { intentTerms } from "@/embedding/semantic-search";
import { listRepoFiles } from "@/git";
import { writeAtomically } from "@/support/atomic-write";
import { CORTEX_VERSION } from "@/version";

export const BENCHMARKS_FILE = "BENCHMARKS.md";

const CORTEX_PREFIX = ".cortex/";
// git's own test for a file it will not diff: a NUL byte means not text.
const NUL = "\u0000";

export async function runBenchmark(
	args: string[],
	cwd: string,
): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			json: { type: "boolean", default: false },
			write: { type: "boolean", default: false },
			limit: { type: "string" },
		},
	});
	const limit = parseLimit(values.limit);
	if (limit === "invalid") return usageError("benchmark");
	return withRuntime(cwd, async (runtime) => {
		const report = await measure(runtime, limit);
		if (values.json) printJson(report);
		else console.log(formatBenchmarkTable(report));
		if (values.write) await write(runtime.repoRoot, report);
		return 0;
	});
}

function parseLimit(raw: string | undefined): number | null | "invalid" {
	if (raw === undefined) return null;
	const limit = Number(raw);
	if (!Number.isInteger(limit) || limit < 1) return "invalid";
	return limit;
}

async function measure(runtime: CortexRuntime, limit: number | null) {
	const decisions = runtime.nodes.listActive();
	return measureBenchmark(
		runtime.projectCanonicalId,
		questionsFromDecisions(decisions, limit),
		{
			decisions: await decisionCorpus(runtime, decisions),
			repository: new RepositoryCorpus(await repositoryFiles(runtime.repoRoot)),
		},
		retrievalPath(runtime),
	);
}

function retrievalPath(runtime: CortexRuntime): RetrievalPath {
	return {
		name: runtime.provider ? `${runtime.pinnedModelId} + fts` : "fts only",
		retrieve: async (query) => {
			const results = await searchDecisions(runtime, [query], false);
			return results.map((result) => result.node.id);
		},
		termsOf: intentTerms,
	};
}

// The file is what the agent would read, so the file is what gets counted; the
// stored row stands in only for a decision whose file this branch lost, which
// the reconciler would have marked absent anyway.
async function decisionCorpus(
	runtime: CortexRuntime,
	decisions: Array<{ id: string; title: string; body: string }>,
): Promise<DecisionCorpus> {
	const store = DecisionStore.at(runtime.cortexDir);
	const entries = await Promise.all(
		decisions.map(async (decision) => ({
			id: decision.id,
			text:
				(await readTextOrNull(store.pathFor(decision.id))) ??
				`${decision.title}\n\n${decision.body}`,
		})),
	);
	return new DecisionCorpus(entries);
}

// Excluding the file this command writes keeps a second run measuring the same
// repository the first one did.
async function repositoryFiles(repoRoot: string): Promise<RepositoryFile[]> {
	const paths = (listRepoFiles(repoRoot) ?? [])
		.filter((path) => !path.startsWith(CORTEX_PREFIX))
		.filter((path) => path !== BENCHMARKS_FILE);
	const files = await Promise.all(
		paths.map(async (path) => ({
			path,
			text: await readTextOrNull(join(repoRoot, path)),
		})),
	);
	return files.flatMap(toReadableText);
}

function toReadableText(file: {
	path: string;
	text: string | null;
}): RepositoryFile[] {
	if (file.text === null || file.text.includes(NUL)) return [];
	return [{ path: file.path, text: file.text }];
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

async function write(
	repoRoot: string,
	report: Awaited<ReturnType<typeof measure>>,
): Promise<void> {
	const path = join(repoRoot, BENCHMARKS_FILE);
	await writeAtomically(path, formatBenchmarkMarkdown(report, stamp()));
	console.log(success(`wrote ${style.cyan(BENCHMARKS_FILE)}`));
}

function stamp(): BenchmarkStamp {
	return {
		date: new Date().toISOString().slice(0, 10),
		version: CORTEX_VERSION,
	};
}
