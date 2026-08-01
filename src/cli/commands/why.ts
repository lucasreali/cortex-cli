import { parseArgs } from "node:util";
import { accessCodeIndex } from "@/app/code-index-access";
import type { CortexRuntime } from "@/app/runtime";
import { printJson } from "@/cli/json";
import { openInitializedRuntime } from "@/cli/open-runtime";
import { style, warning } from "@/cli/style";
import type { Decision } from "@/domain";

interface SymbolMatch {
	filePath: string;
	line: number;
	decisions: Decision[];
}

type WhyReport =
	| { target: string; matchedBy: "path"; decisions: Decision[] }
	| { target: string; matchedBy: "symbol"; locations: SymbolMatch[] }
	| { target: string; matchedBy: null; codeWarning?: string };

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
	if (target.includes("/")) {
		return { target, matchedBy: null };
	}
	return (await symbolReport(runtime, target)) ?? { target, matchedBy: null };
}

async function symbolReport(
	runtime: CortexRuntime,
	symbol: string,
): Promise<WhyReport | null> {
	const access = await accessCodeIndex(runtime.codeIndex);
	if (!access.ok) {
		return { target: symbol, matchedBy: null, codeWarning: access.warning };
	}
	const locations = access.code.findSymbol(symbol).map((location) => ({
		filePath: location.filePath,
		line: location.line,
		decisions: runtime.nodes.listByFileAnchorOrSymbol(
			location.filePath,
			symbol,
		),
	}));
	if (locations.length === 0) return null;
	return { target: symbol, matchedBy: "symbol", locations };
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
	if (report.codeWarning) {
		console.log(warning(report.codeWarning));
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
