import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
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
		const lines = values.exact
			? exactLines(runtime, positionals)
			: await semanticLines(runtime, positionals);
		if (lines.length === 0) {
			console.log("No results.");
			return 0;
		}
		for (const line of lines) {
			console.log(line);
		}
		return 0;
	} finally {
		runtime.dispose();
	}
}

function exactLines(runtime: CortexRuntime, terms: string[]): string[] {
	return runtime.fts.searchExact(terms).flatMap((hit) => {
		const node = runtime.nodes.getById(hit.nodeId);
		if (node?.status !== "active") return [];
		return [`${(-hit.rank).toFixed(3)}  fts     ${node.title} (${node.id})`];
	});
}

async function semanticLines(
	runtime: CortexRuntime,
	terms: string[],
): Promise<string[]> {
	const results = await runtime.semanticSearch.search(terms.join(" "));
	return results.map(
		(result) =>
			`${result.score.toFixed(3)}  ${result.source.padEnd(6)}  ${result.node.title} (${result.node.id})`,
	);
}
