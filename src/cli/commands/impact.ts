import { parseArgs } from "node:util";
import {
	DEFAULT_IMPACT_DEPTH,
	type DecisionImpact,
	decisionImpact,
} from "@/app/decision-impact";
import { openInitializedRuntime } from "../open-runtime";

export async function runImpact(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { depth: { type: "string" } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) {
		console.error("usage: cortex impact <id> [--depth N]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const depth = values.depth ? Number(values.depth) : DEFAULT_IMPACT_DEPTH;
		const impact = await decisionImpact(runtime, id, {
			maxDepth: depth,
			codeDepth: depth,
		});
		if (!impact) {
			console.error(`decision not found: ${id}`);
			return 1;
		}
		printDependsOnTree(impact);
		printCodeImpact(impact);
		return 0;
	} finally {
		runtime.dispose();
	}
}

function printDependsOnTree(impact: DecisionImpact): void {
	console.log(`${impact.root.title} (${impact.root.id})`);
	for (const entry of impact.impacted) {
		const marker = entry.node.status === "replaced" ? " [replaced]" : "";
		console.log(
			`${"  ".repeat(entry.depth)}└─ ${entry.node.title}${marker} (${entry.node.id})`,
		);
	}
}

function printCodeImpact(impact: DecisionImpact): void {
	if (impact.codeWarning) {
		console.log(`\n${impact.codeWarning}`);
		return;
	}
	if (impact.codeImpacted.length === 0) return;
	console.log("\nVia code (imports):");
	for (const entry of impact.codeImpacted) {
		console.log(
			`  ${entry.filePath} (${entry.depth} hop${entry.depth === 1 ? "" : "s"}, ${entry.provenance})`,
		);
		console.log(`    └─ ${entry.decision.title} (${entry.decision.id})`);
	}
}
