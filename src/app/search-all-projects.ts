import type {
	QueryVector,
	SemanticSearchResult,
} from "@/embedding/semantic-search";
import { errorMessage } from "@/support/errors";
import type { ProjectReader } from "./project-reader";

export interface SweepTarget {
	root: string;
	canonicalId: string;
}

export interface ProjectSearchResults {
	project: string;
	root: string;
	results: SemanticSearchResult[];
}

export interface SkippedProject {
	root: string;
	reason: string;
}

export interface AllProjectsSearch {
	projects: ProjectSearchResults[];
	skipped: SkippedProject[];
}

export interface SweepOptions {
	maxProjects?: number;
	deadlineMs?: number;
}

export interface Sweep {
	targets: SweepTarget[];
	open: (root: string) => ProjectReader;
	terms: string[];
	exact: boolean;
	vector: QueryVector | null;
}

const DEFAULT_MAX_PROJECTS = 50;
const DEFAULT_DEADLINE_MS = 10_000;

// Results stay grouped per project, never fused into one ranked list: scores
// from different stores are not comparable, and the label is what keeps a
// cross-project answer from being mistaken for a scoped one. A project that
// fails to open is skipped with its reason — one broken store must not take
// the whole sweep down.
//
// The sweep is bounded twice, because the registry grows without limit and a
// tool call the client will time out on is worse than a narrowed answer: at
// most maxProjects roots are visited, and the rest are reported as skipped the
// moment the deadline passes. Reading a store is synchronous, so the loop
// yields between projects rather than running them concurrently — that is what
// keeps the server's transport answering while a long sweep runs.
export async function searchAllProjects(
	sweep: Sweep,
	options: SweepOptions = {},
): Promise<AllProjectsSearch> {
	const query = {
		terms: sweep.terms,
		exact: sweep.exact,
		vector: sweep.vector,
	};
	const budget = new SweepBudget(options);
	const projects: ProjectSearchResults[] = [];
	const skipped: SkippedProject[] = [];
	for (const target of sweep.targets) {
		const reason = budget.exhaustedFor(projects.length + skipped.length);
		if (reason) {
			skipped.push({ root: target.root, reason });
			continue;
		}
		await yieldToEventLoop();
		const outcome = searchOne(target, sweep.open, query);
		if ("reason" in outcome) skipped.push(outcome);
		else projects.push(outcome);
	}
	return { projects, skipped };
}

class SweepBudget {
	private readonly startedAt = Date.now();

	constructor(private readonly options: SweepOptions) {}

	exhaustedFor(visited: number): string | null {
		if (visited >= this.maxProjects()) {
			return `not searched: this sweep is capped at ${this.maxProjects()} projects`;
		}
		if (Date.now() - this.startedAt >= this.deadlineMs()) {
			return `not searched: the sweep reached its ${this.deadlineMs()} ms deadline`;
		}
		return null;
	}

	private maxProjects(): number {
		return this.options.maxProjects ?? DEFAULT_MAX_PROJECTS;
	}

	private deadlineMs(): number {
		return this.options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	}
}

function searchOne(
	target: SweepTarget,
	open: (root: string) => ProjectReader,
	query: { terms: string[]; exact: boolean; vector: QueryVector | null },
): ProjectSearchResults | SkippedProject {
	let reader: ProjectReader | null = null;
	try {
		reader = open(target.root);
		const results = reader.find(query);
		return { project: target.canonicalId, root: target.root, results };
	} catch (error) {
		return { root: target.root, reason: errorMessage(error) };
	} finally {
		reader?.close();
	}
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
