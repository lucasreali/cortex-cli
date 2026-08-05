import { parseArgs } from "node:util";
import { buildRuntimeAt, type CortexRuntime } from "@/app/runtime";
import {
	type AllProjectsSearch,
	searchAllProjects,
} from "@/app/search-all-projects";
import { searchDecisions } from "@/app/search-decisions";
import { printJson } from "@/cli/json";
import { projectRootFor, withRuntime } from "@/cli/open-runtime";
import { style, warning } from "@/cli/style";
import { usageError } from "@/cli/usage";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import { readRegisteredProjects } from "@/storage/project-registry";

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
	if (positionals.length === 0) return usageError("search");
	if (values["all-projects"]) {
		return searchEverywhere(cwd, positionals, values.exact, values.json);
	}
	return withRuntime(cwd, async (runtime) => {
		const results = await searchDecisions(runtime, positionals, values.exact);
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
// joined in case it was initialized before the registry existed.
async function searchEverywhere(
	cwd: string,
	terms: string[],
	exact: boolean,
	json: boolean,
): Promise<number> {
	const opened: CortexRuntime[] = [];
	try {
		const outcome = await searchAllProjects(
			knownRoots(cwd),
			async (root) => {
				const runtime = await buildRuntimeAt(root, { sharedEmbedding: true });
				opened.push(runtime);
				runtime.decisions.ensure();
				return runtime;
			},
			terms,
			exact,
		);
		printEverywhere(outcome, json);
		return 0;
	} finally {
		for (const runtime of opened) runtime.dispose();
	}
}

function knownRoots(cwd: string): string[] {
	const roots = readRegisteredProjects().map((project) => project.root);
	const current = projectRootFor(cwd);
	if (current.isInitialized() && !roots.includes(current.directory)) {
		roots.push(current.directory);
	}
	return roots;
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
	const score = style.dim(result.score.toFixed(3));
	const id = style.dim(result.node.id);
	return `${score}  ${paintSource(result.source)}  ${result.node.title}  ${id}`;
}

function paintSource(source: SemanticSearchResult["source"]): string {
	const label = source.padEnd(6);
	if (source === "fts") return style.yellow(label);
	return style.magenta(label);
}
