import { parseArgs } from "node:util";
import type { Decision } from "@/domain";
import type { CortexRuntime } from "@/mcp/runtime";
import { openInitializedRuntime } from "../open-runtime";

export async function runWhy(args: string[], cwd: string): Promise<number> {
	const { positionals } = parseArgs({ args, allowPositionals: true });
	const target = positionals[0];
	if (!target) {
		console.error("usage: cortex why <path|symbol>");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const byPath = runtime.nodes.listByAnchorPath(target);
		if (byPath.length > 0) {
			printDecisions(byPath);
			return 0;
		}
		if (!target.includes("/") && (await printSymbol(runtime, target))) {
			return 0;
		}
		console.log(`No decisions anchored to ${target}.`);
		return 0;
	} finally {
		runtime.dispose();
	}
}

async function printSymbol(
	runtime: CortexRuntime,
	symbol: string,
): Promise<boolean> {
	const code = await runtime.codeIndex.repository();
	const locations = code.findSymbol(symbol);
	if (locations.length === 0) return false;
	for (const location of locations) {
		console.log(`${symbol} — ${location.filePath}:${location.line}`);
		const decisions = runtime.nodes.listByFileAnchorOrSymbol(
			location.filePath,
			symbol,
		);
		if (decisions.length === 0) {
			console.log("  no decisions anchored here");
			continue;
		}
		printDecisions(decisions, "  ");
	}
	return true;
}

function printDecisions(decisions: Decision[], indent = ""): void {
	for (const decision of decisions) {
		const marker = decision.status === "replaced" ? " [replaced]" : "";
		console.log(
			`${indent}${decision.createdAt.slice(0, 10)}  ${decision.title}${marker} (${decision.id})`,
		);
	}
}
