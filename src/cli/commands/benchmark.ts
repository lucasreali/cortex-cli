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
	generatedDate,
} from "@/benchmark/report";
import {
	RepositoryCorpus,
	type RepositoryFile,
} from "@/benchmark/repository-corpus";
import { usageError } from "@/cli/error-output";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { failure, style, success, warning } from "@/cli/style";
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
		if (!values.write) return 0;
		return write(runtime.repoRoot, report);
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
	const repository = await readRepository(runtime.repoRoot);
	reportUnreadable(repository.unreadable);
	return measureBenchmark(
		runtime.projectCanonicalId,
		questionsFromDecisions(decisions, limit),
		{
			decisions: await decisionCorpus(runtime, decisions),
			repository: new RepositoryCorpus(repository.files),
		},
		retrievalPath(runtime),
	);
}

// A file the baseline could not read is a file the baseline does not charge
// for, which understates the alternative cortex is being compared against.
// Saying so is the difference between a caveat and a silently better number.
function reportUnreadable(paths: string[]): void {
	if (paths.length === 0) return;
	console.error(
		warning(
			`${paths.length} file(s) could not be read; the grep baseline excludes them, starting with ${paths[0]}`,
		),
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

// Every file at once opens one descriptor per tracked file, and a repository
// larger than the process's limit answers EMFILE — which this command used to
// read as "empty file" and charge the grep baseline nothing for. Reading in
// batches keeps the descriptor count bounded by this number rather than by the
// size of the repository being measured.
const OPEN_AT_ONCE = 32;

// What the grep baseline is charged for, and what it silently is not.
class RepositoryReading {
	readonly files: RepositoryFile[] = [];
	readonly unreadable: string[] = [];

	// A binary blob is dropped without a word — a grep session would not read it
	// either — while a file that refused to open is something the caller has to
	// hear about.
	add(path: string, text: string | null): void {
		if (text === null) {
			this.unreadable.push(path);
			return;
		}
		if (text.includes(NUL)) return;
		this.files.push({ path, text });
	}
}

// Excluding the file this command writes keeps a second run measuring the same
// repository the first one did.
async function readRepository(repoRoot: string): Promise<RepositoryReading> {
	const paths = (listRepoFiles(repoRoot) ?? [])
		.filter((path) => !path.startsWith(CORTEX_PREFIX))
		.filter((path) => path !== BENCHMARKS_FILE);
	const reading = new RepositoryReading();
	for (let start = 0; start < paths.length; start += OPEN_AT_ONCE) {
		const batch = paths.slice(start, start + OPEN_AT_ONCE);
		const texts = await Promise.all(
			batch.map((path) => readTextOrNull(join(repoRoot, path))),
		);
		batch.forEach((path, index) => {
			reading.add(path, texts[index] ?? null);
		});
	}
	return reading;
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await Bun.file(path).text();
	} catch {
		return null;
	}
}

// The file is this command's to rewrite only if this command wrote it: a
// BENCHMARKS.md carrying no generated line is a person's, and replacing it
// without being asked would be data loss the flag never promised.
async function write(
	repoRoot: string,
	report: Awaited<ReturnType<typeof measure>>,
): Promise<number> {
	const path = join(repoRoot, BENCHMARKS_FILE);
	const existing = await readTextOrNull(path);
	const stampedBefore = existing === null ? null : generatedDate(existing);
	if (existing !== null && stampedBefore === null) return refuse(path);
	if (unchangedSince(report, existing, stampedBefore)) {
		console.log(success(`${style.cyan(BENCHMARKS_FILE)} is already current`));
		return 0;
	}
	await writeAtomically(path, formatBenchmarkMarkdown(report, stamp(today())));
	console.log(success(`wrote ${style.cyan(BENCHMARKS_FILE)}`));
	return 0;
}

// Every number in the file moves with the corpus, so the date is the one line
// that would change on its own. Re-stamping it turns a re-run that measured
// exactly the same thing into a diff, which is how a generated file starts
// being committed for no reason.
function unchangedSince(
	report: Awaited<ReturnType<typeof measure>>,
	existing: string | null,
	stampedBefore: string | null,
): boolean {
	if (existing === null || stampedBefore === null) return false;
	return formatBenchmarkMarkdown(report, stamp(stampedBefore)) === existing;
}

function refuse(path: string): number {
	console.error(
		failure(
			`${path} was not written by \`cortex benchmark --write\` and will not be replaced; move it aside first`,
		),
	);
	return 1;
}

function stamp(date: string): BenchmarkStamp {
	return { date, version: CORTEX_VERSION };
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}
