import type { SemanticSearchResult } from "@/embedding/semantic-search";
import { errorMessage } from "@/support/errors";
import type { CortexRuntime } from "./runtime";
import { searchDecisions } from "./search-decisions";

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

// Results stay grouped per project, never fused into one ranked list: scores
// from different stores are not comparable, and the label is what keeps a
// cross-project answer from being mistaken for a scoped one. A project that
// fails to open is skipped with its reason — one broken store must not take
// the whole sweep down.
export async function searchAllProjects(
	roots: string[],
	open: (root: string) => Promise<CortexRuntime>,
	terms: string[],
	exact: boolean,
): Promise<AllProjectsSearch> {
	const projects: ProjectSearchResults[] = [];
	const skipped: SkippedProject[] = [];
	for (const root of roots) {
		const outcome = await searchOne(root, open, terms, exact);
		if ("reason" in outcome) skipped.push(outcome);
		else projects.push(outcome);
	}
	return { projects, skipped };
}

async function searchOne(
	root: string,
	open: (root: string) => Promise<CortexRuntime>,
	terms: string[],
	exact: boolean,
): Promise<ProjectSearchResults | SkippedProject> {
	try {
		const runtime = await open(root);
		const results = await searchDecisions(runtime, terms, exact);
		return { project: runtime.projectCanonicalId, root, results };
	} catch (error) {
		return { root, reason: errorMessage(error) };
	}
}
