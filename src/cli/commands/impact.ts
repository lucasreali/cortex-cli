import { parseArgs } from "node:util";
import {
	DEFAULT_IMPACT_DEPTH,
	type DecisionImpact,
	decisionImpact,
} from "@/app/decision-impact";
import { confidenceTag } from "@/cli/anchor-tag";
import { presentArguments, wholeNumber } from "@/cli/arguments";
import { reportFailure, usageError } from "@/cli/error-output";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { style, warning } from "@/cli/style";

export async function runImpact(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			depth: { type: "string" },
			json: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});
	const [id] = presentArguments(positionals);
	if (!id) return usageError("impact");
	const depth = parseDepth(values.depth);
	if (depth === null) {
		reportFailure("--depth N must be a non-negative integer");
		return usageError("impact");
	}
	return withRuntime(cwd, async (runtime) => {
		const impact = await decisionImpact(runtime, id, {
			maxDepth: depth,
			codeDepth: depth,
		});
		if (!impact) {
			reportFailure(`decision not found: ${id}`);
			return 1;
		}
		if (values.json) {
			printJson(impact);
			return 0;
		}
		printDependsOnTree(impact);
		printConflicts(impact);
		printAnchors(impact);
		printCodeImpact(impact);
		return 0;
	});
}

function parseDepth(raw: string | undefined): number | null {
	if (raw === undefined) return DEFAULT_IMPACT_DEPTH;
	return wholeNumber(raw);
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

function printConflicts(impact: DecisionImpact): void {
	if (impact.conflicts.length === 0) return;
	console.log(`\n${style.bold("Conflicts with:")}`);
	for (const conflict of impact.conflicts) {
		console.log(`  ${conflict.title}  ${style.dim(conflict.id)}`);
	}
}

function printAnchors(impact: DecisionImpact): void {
	if (impact.root.anchors.length === 0) return;
	console.log(`\n${style.bold("Anchors:")}`);
	for (const anchor of impact.root.anchors) {
		const target = anchor.symbol
			? `${anchor.filePath}#${anchor.symbol}`
			: anchor.filePath;
		console.log(`  ${style.cyan(target)} ${confidenceTag(anchor.confidence)}`);
	}
}

function printCodeImpact(impact: DecisionImpact): void {
	if (impact.codeWarning) {
		console.log(`\n${warning(impact.codeWarning)}`);
		return;
	}
	if (impact.codeTruncated) {
		console.log(
			`\n${warning("import walk truncated: showing the shallowest hops only; lower --depth for a complete answer")}`,
		);
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
