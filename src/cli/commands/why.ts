import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import { openInitializedRuntime } from "../open-runtime";
import { style } from "../style";

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
			console.log(style.cyan(target));
			printDecisions(byPath, "  ");
			return 0;
		}
		if (!target.includes("/") && (await printSymbol(runtime, target))) {
			return 0;
		}
		console.log(style.dim(`No decisions anchored to ${target}.`));
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
		console.log(
			`${style.bold(symbol)} — ${style.cyan(`${location.filePath}:${location.line}`)}`,
		);
		const decisions = runtime.nodes.listByFileAnchorOrSymbol(
			location.filePath,
			symbol,
		);
		if (decisions.length === 0) {
			console.log(style.dim("  no decisions anchored here"));
			continue;
		}
		printDecisions(decisions, "  ");
	}
	return true;
}

function printDecisions(decisions: Decision[], indent = ""): void {
	for (const decision of decisions) {
		const marker =
			decision.status === "replaced" ? ` ${style.yellow("[replaced]")}` : "";
		const date = style.dim(decision.createdAt.slice(0, 10));
		console.log(
			`${indent}${date}  ${decision.title}${marker}  ${style.dim(decision.id)}`,
		);
	}
}
