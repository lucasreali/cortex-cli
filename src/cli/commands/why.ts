import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import type { Decision } from "@/domain";
import { printJson } from "../json";
import { openInitializedRuntime } from "../open-runtime";
import { style } from "../style";

interface SymbolMatch {
	filePath: string;
	line: number;
	decisions: Decision[];
}

type WhyReport =
	| { target: string; matchedBy: "path"; decisions: Decision[] }
	| { target: string; matchedBy: "symbol"; locations: SymbolMatch[] }
	| { target: string; matchedBy: null };

export async function runWhy(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean", default: false } },
		allowPositionals: true,
	});
	const target = positionals[0];
	if (!target) {
		console.error("usage: cortex why <path|symbol> [--json]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const report = await buildReport(runtime, target);
		if (values.json) {
			printJson(report);
			return 0;
		}
		render(report);
		return 0;
	} finally {
		runtime.dispose();
	}
}

async function buildReport(
	runtime: CortexRuntime,
	target: string,
): Promise<WhyReport> {
	const byPath = runtime.nodes.listByAnchorPath(target);
	if (byPath.length > 0) {
		return { target, matchedBy: "path", decisions: byPath };
	}
	if (!target.includes("/")) {
		const locations = await findSymbolMatches(runtime, target);
		if (locations.length > 0) {
			return { target, matchedBy: "symbol", locations };
		}
	}
	return { target, matchedBy: null };
}

async function findSymbolMatches(
	runtime: CortexRuntime,
	symbol: string,
): Promise<SymbolMatch[]> {
	const code = await runtime.codeIndex.repository();
	return code.findSymbol(symbol).map((location) => ({
		filePath: location.filePath,
		line: location.line,
		decisions: runtime.nodes.listByFileAnchorOrSymbol(
			location.filePath,
			symbol,
		),
	}));
}

function render(report: WhyReport): void {
	if (report.matchedBy === "path") {
		console.log(style.cyan(report.target));
		printDecisions(report.decisions, "  ");
		return;
	}
	if (report.matchedBy === "symbol") {
		renderSymbolMatches(report.target, report.locations);
		return;
	}
	console.log(style.dim(`No decisions anchored to ${report.target}.`));
}

function renderSymbolMatches(symbol: string, locations: SymbolMatch[]): void {
	for (const location of locations) {
		console.log(
			`${style.bold(symbol)} — ${style.cyan(`${location.filePath}:${location.line}`)}`,
		);
		if (location.decisions.length === 0) {
			console.log(style.dim("  no decisions anchored here"));
			continue;
		}
		printDecisions(location.decisions, "  ");
	}
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
