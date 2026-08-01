import { parseArgs } from "node:util";
import { searchDecisions } from "@/app/search-decisions";
import { printJson } from "@/cli/json";
import { openInitializedRuntime } from "@/cli/open-runtime";
import { style } from "@/cli/style";
import type { SemanticSearchResult } from "@/embedding/semantic-search";

export async function runSearch(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			exact: { type: "boolean", default: false },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	if (positionals.length === 0) {
		console.error("usage: cortex search <terms...> [--exact] [--json]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
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
	} finally {
		runtime.dispose();
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
