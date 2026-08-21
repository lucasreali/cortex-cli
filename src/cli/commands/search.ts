import { parseArgs } from "node:util";
import { ProjectReader } from "@/app/project-reader";
import {
	type AllProjectsSearch,
	type SweepTarget,
	searchAllProjects,
} from "@/app/search-all-projects";
import { searchDecisions } from "@/app/search-decisions";
import { embedSweepQuery, sweepModelId } from "@/app/sweep-query";
import { presentArguments } from "@/cli/arguments";
import { usageError } from "@/cli/error-output";
import { printJson } from "@/cli/json";
import { projectRootFor, withRuntime } from "@/cli/open-runtime";
import { style, warning } from "@/cli/style";
import {
	createProvider,
	embeddingsDisabled,
} from "@/embedding/create-provider";
import {
	type QueryVector,
	SCORE_PRECISION,
	type SemanticSearchResult,
} from "@/embedding/semantic-search";
import { getCanonicalProjectId } from "@/git";
import { searchQuery } from "@/querylog/entry";
import {
	type ProjectRegistryRead,
	projectsRegistryPath,
	readProjectRegistry,
} from "@/storage/project-registry";

export async function runSearch(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			exact: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
			"all-projects": { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const terms = presentArguments(positionals);
	if (terms.length === 0) return usageError("search");
	if (values["all-projects"]) {
		return searchEverywhere(cwd, terms, values.exact, values.json);
	}
	return withRuntime(cwd, async (runtime) => {
		const results = await searchDecisions(runtime, terms, values.exact);
		runtime.queries.record(
			searchQuery(terms, values.exact),
			results.map((result) => result.node.id),
		);
		if (values.json) {
			printJson(results);
			return 0;
		}
		if (results.length === 0) {
			console.log(style.dim("No results."));
			return 0;
		}
		for (const result of results) {
			console.log(formatLine(result));
		}
		return 0;
	});
}

// Unlike the scoped form this works from anywhere, including outside any
// project: the registry is the source of roots, with the current project
// joined in case it was initialized before the registry existed. Every project
// but the current one is opened read-only — a search must not migrate,
// reconcile or write to a project the user only asked about.
async function searchEverywhere(
	cwd: string,
	terms: string[],
	exact: boolean,
	json: boolean,
): Promise<number> {
	const registry = readProjectRegistry();
	reportUnreadableRegistry(registry);
	const targets = knownTargets(registry, cwd);
	const outcome = await searchAllProjects({
		targets,
		open: (root) => ProjectReader.open(root),
		terms,
		exact,
		vector: exact ? null : await queryVector(targets, terms),
	});
	printEverywhere(outcome, json);
	return 0;
}

// One embedding for the whole sweep, on a worker that is disposed with it:
// embedding the same text once per project is what made this command scale
// with the number of registered projects instead of with the query.
async function queryVector(
	targets: SweepTarget[],
	terms: string[],
): Promise<QueryVector | null> {
	if (embeddingsDisabled() || targets.length === 0) return null;
	const provider = createProvider(await sweepModelId(targets[0]?.root ?? null));
	try {
		return await embedSweepQuery(provider, terms.join(" "));
	} catch {
		return null;
	} finally {
		provider.dispose?.();
	}
}

function knownTargets(
	registry: ProjectRegistryRead,
	cwd: string,
): SweepTarget[] {
	const targets: SweepTarget[] =
		registry.state === "ok"
			? registry.projects.map((project) => ({
					root: project.root,
					canonicalId: project.canonicalId,
				}))
			: [];
	const current = projectRootFor(cwd);
	const alreadyKnown = targets.some(
		(target) => target.root === current.directory,
	);
	if (!current.isInitialized() || alreadyKnown) return targets;
	return [
		...targets,
		{
			root: current.directory,
			canonicalId:
				getCanonicalProjectId(current.directory) ?? current.directory,
		},
	];
}

// An unreadable registry narrows the sweep to the current project, so saying
// nothing would pass a partial answer off as a complete one.
function reportUnreadableRegistry(registry: ProjectRegistryRead): void {
	if (registry.state !== "unreadable") return;
	console.error(
		warning(
			`project registry at ${projectsRegistryPath()} is not valid JSON — ` +
				"only the current project was searched",
		),
	);
}

function printEverywhere(outcome: AllProjectsSearch, json: boolean): void {
	if (json) {
		printJson(outcome);
		return;
	}
	for (const skippedProject of outcome.skipped) {
		console.error(
			warning(`skipped ${skippedProject.root}: ${skippedProject.reason}`),
		);
	}
	if (outcome.projects.every((project) => project.results.length === 0)) {
		console.log(style.dim("No results in any registered project."));
		return;
	}
	for (const project of outcome.projects) {
		if (project.results.length === 0) continue;
		console.log(style.bold(project.project));
		for (const result of project.results) {
			console.log(`  ${formatLine(result)}`);
		}
	}
}

function formatLine(result: SemanticSearchResult): string {
	const score = style.dim(result.score.toFixed(SCORE_PRECISION));
	const id = style.dim(result.node.id);
	return `${score}  ${paintSource(result.source)}  ${result.node.title}  ${id}`;
}

function paintSource(source: SemanticSearchResult["source"]): string {
	const label = source.padEnd(6);
	if (source === "fts") return style.yellow(label);
	return style.magenta(label);
}
