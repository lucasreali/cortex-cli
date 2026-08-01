import { parseArgs } from "node:util";
import {
	DEFAULT_IMPACT_DEPTH,
	type DecisionImpact,
	decisionImpact,
} from "@/app/decision-impact";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { failure, style, warning } from "@/cli/style";
import { usageError } from "@/cli/usage";

export async function runImpact(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			depth: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) return usageError("impact");
	const depth = parseDepth(values.depth);
	if (depth === null) {
		console.error(failure("--depth N must be a non-negative integer"));
		return usageError("impact");
	}
	return withRuntime(cwd, async (runtime) => {
		const impact = await decisionImpact(runtime, id, {
			maxDepth: depth,
			codeDepth: depth,
		});
		if (!impact) {
			console.error(failure(`decision not found: ${id}`));
			return 1;
		}
		if (values.json) {
			printJson(impact);
			return 0;
		}
		printDependsOnTree(impact);
		printCodeImpact(impact);
		return 0;
	});
}

function parseDepth(raw: string | undefined): number | null {
	if (raw === undefined) return DEFAULT_IMPACT_DEPTH;
	const depth = Number(raw);
	return Number.isInteger(depth) && depth >= 0 ? depth : null;
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
