import { parseArgs } from "node:util";
import {
	type AnchoredDecision,
	indexedAnchorResolver,
	labelAnchors,
	type ResolvedAnchor,
	strongestConfidence,
} from "@/app/anchor-confidence";
import { accessCodeIndex } from "@/app/code-index-access";
import type { CortexRuntime } from "@/app/runtime";
import { confidenceTag } from "@/cli/anchor-tag";
import { presentArguments } from "@/cli/arguments";
import { usageError } from "@/cli/error-output";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { style, warning } from "@/cli/style";

interface SymbolMatch {
	filePath: string;
	line: number;
	decisions: AnchoredDecision[];
}

type WhyReport =
	| { target: string; matchedBy: "path"; decisions: AnchoredDecision[] }
	| { target: string; matchedBy: "symbol"; locations: SymbolMatch[] }
	| { target: string; matchedBy: null; codeWarning?: string };

type AnchorFilter = (anchor: ResolvedAnchor) => boolean;

export async function runWhy(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { json: { type: "boolean", default: false } },
		allowPositionals: true,
	});
	const [target] = presentArguments(positionals);
	if (!target) return usageError("why");
	return withRuntime(cwd, async (runtime) => {
		const report = await buildReport(runtime, target);
		if (values.json) {
			printJson(report);
			return 0;
		}
		render(report);
		return 0;
	});
}

async function buildReport(
	runtime: CortexRuntime,
	target: string,
): Promise<WhyReport> {
	const byPath = runtime.nodes.listByAnchorPath(target);
	if (byPath.length > 0) {
		return {
			target,
			matchedBy: "path",
			decisions: await labelAnchors(runtime, byPath),
		};
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
	const resolver = indexedAnchorResolver(runtime.repoRoot, access.code);
	const locations = access.code.findSymbol(symbol).map((location) => ({
		filePath: location.filePath,
		line: location.line,
		decisions: runtime.nodes
			.listByFileAnchorOrSymbol(location.filePath, symbol)
			.map((decision) => resolver.label(decision)),
	}));
	if (locations.length === 0) return null;
	return { target: symbol, matchedBy: "symbol", locations };
}

function render(report: WhyReport): void {
	if (report.matchedBy === "path") {
		console.log(style.cyan(report.target));
		printDecisions(report.decisions, under(report.target), "  ");
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
		printDecisions(location.decisions, inFile(location.filePath), "  ");
	}
}

// The label a reader wants is the one on the anchor that produced the match,
// not on every anchor the decision happens to carry.
function under(target: string): AnchorFilter {
	const prefix = target.replace(/\/+$/, "");
	return (anchor) =>
		anchor.filePath === prefix || anchor.filePath.startsWith(`${prefix}/`);
}

function inFile(filePath: string): AnchorFilter {
	return (anchor) => anchor.filePath === filePath;
}

function printDecisions(
	decisions: AnchoredDecision[],
	matches: AnchorFilter,
	indent = "",
): void {
	for (const decision of decisions) {
		const marker =
			decision.status === "replaced" ? ` ${style.yellow("[replaced]")}` : "";
		const date = style.dim(decision.createdAt.slice(0, 10));
		const tag = matchedTag(decision, matches);
		console.log(
			`${indent}${date}  ${decision.title}${marker}${tag}  ${style.dim(decision.id)}`,
		);
	}
}

function matchedTag(decision: AnchoredDecision, matches: AnchorFilter): string {
	const confidence = strongestConfidence(decision.anchors.filter(matches));
	if (confidence === null) return "";
	return ` ${confidenceTag(confidence)}`;
}
