import { parseArgs } from "node:util";
import { searchDecisions } from "@/app/search-decisions";
import type { SemanticSearchResult } from "@/embedding/semantic-search";
import { openInitializedRuntime } from "../open-runtime";

export async function runSearch(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { exact: { type: "boolean", default: false } },
		allowPositionals: true,
	});
	if (positionals.length === 0) {
		console.error("usage: cortex search <terms...> [--exact]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const results = await searchDecisions(runtime, positionals, values.exact);
		if (results.length === 0) {
			console.log("No results.");
			return 0;
		}
		for (const result of results) {
			console.log(formatLine(result));
		}
		return 0;
	} finally {
		runtime.dispose();
	}
}

function formatLine(result: SemanticSearchResult): string {
	return `${result.score.toFixed(3)}  ${result.source.padEnd(6)}  ${result.node.title} (${result.node.id})`;
}
