import { parseArgs } from "node:util";
import {
	DEFAULT_IMPACT_DEPTH,
	type DecisionImpact,
	decisionImpact,
} from "@/app/decision-impact";
import { openInitializedRuntime } from "../open-runtime";
import { failure, style, warning } from "../style";

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
			console.error(failure(`decision not found: ${id}`));
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
	console.log(`${style.bold(impact.root.title)}  ${style.dim(impact.root.id)}`);
	for (const entry of impact.impacted) {
		const marker =
			entry.node.status === "replaced" ? ` ${style.yellow("[replaced]")}` : "";
		const connector = `${"  ".repeat(entry.depth)}${style.dim("└─")}`;
		console.log(
			`${connector} ${entry.node.title}${marker}  ${style.dim(entry.node.id)}`,
		);
	}
}

function printCodeImpact(impact: DecisionImpact): void {
	if (impact.codeWarning) {
		console.log(`\n${warning(impact.codeWarning)}`);
		return;
	}
	if (impact.codeImpacted.length === 0) return;
	console.log(`\n${style.bold("Via code (imports):")}`);
	for (const entry of impact.codeImpacted) {
		const hops = `(${entry.depth} hop${entry.depth === 1 ? "" : "s"}, ${entry.provenance})`;
		console.log(`  ${style.cyan(entry.filePath)} ${style.dim(hops)}`);
		console.log(
			`    ${style.dim("└─")} ${entry.decision.title}  ${style.dim(entry.decision.id)}`,
		);
	}
}
