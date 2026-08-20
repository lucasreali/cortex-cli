import type { Decision } from "@/domain";
import {
	type AnchoredDecision,
	type AnchorResolver,
	indexedAnchorResolver,
	unjudgedAnchorResolver,
} from "./anchor-confidence";
import { CodeImpactAnalysis, type CodeImpactedDecision } from "./code-impact";
import { accessCodeIndex } from "./code-index-access";
import type { CortexRuntime } from "./runtime";

export interface ImpactedDecision {
	node: AnchoredDecision;
	depth: number;
}

export interface DecisionImpact {
	root: AnchoredDecision;
	impacted: ImpactedDecision[];
	codeImpacted: CodeImpactedDecision[];
	codeTruncated: boolean;
	codeWarning: string | null;
}

export interface ImpactDepths {
	maxDepth?: number;
	codeDepth?: number;
}

export const DEFAULT_IMPACT_DEPTH = 3;

type ImpactDependencies = Pick<
	CortexRuntime,
	"repoRoot" | "nodes" | "edges" | "codeIndex"
>;

// One look at the code index answers both questions it can answer: which files
// import the anchored ones, and how well each anchor still resolves.
interface CodeLens {
	analysis: CodeImpactAnalysis | null;
	resolver: AnchorResolver;
	warning: string | null;
}

export async function decisionImpact(
	runtime: ImpactDependencies,
	decisionId: string,
	depths: ImpactDepths = {},
): Promise<DecisionImpact | null> {
	const root = presentDecision(runtime, decisionId);
	if (!root) return null;
	const impacted = runtime.edges
		.getImpact(decisionId, depths.maxDepth ?? DEFAULT_IMPACT_DEPTH)
		.flatMap(({ nodeId, depth }) => {
			const node = presentDecision(runtime, nodeId);
			return node ? [{ node, depth }] : [];
		});
	const lens = await codeLens(runtime, [
		root,
		...impacted.map((entry) => entry.node),
	]);
	const code = lens.analysis?.forDecision(
		root,
		depths.codeDepth ?? DEFAULT_IMPACT_DEPTH,
	);
	return {
		root: lens.resolver.label(root),
		impacted: impacted.map((entry) => ({
			node: lens.resolver.label(entry.node),
			depth: entry.depth,
		})),
		codeImpacted: code?.decisions ?? [],
		codeTruncated: code?.truncated ?? false,
		codeWarning: lens.warning,
	};
}

// get-impact.sql walks edges without consulting the working tree, so an
// off-branch decision can be reached from a present one and must be dropped
// here rather than in the recursive query.
function presentDecision(
	runtime: ImpactDependencies,
	decisionId: string,
): Decision | null {
	const decision = runtime.nodes.getById(decisionId);
	if (!decision?.present) return null;
	return decision;
}

async function codeLens(
	runtime: ImpactDependencies,
	decisions: Decision[],
): Promise<CodeLens> {
	if (decisions.every((decision) => decision.anchors.length === 0)) {
		return {
			analysis: null,
			resolver: unjudgedAnchorResolver(),
			warning: null,
		};
	}
	const access = await accessCodeIndex(runtime.codeIndex);
	if (!access.ok) {
		return {
			analysis: null,
			resolver: unjudgedAnchorResolver(),
			warning: access.warning,
		};
	}
	return {
		analysis: new CodeImpactAnalysis(runtime.nodes, access.code),
		resolver: indexedAnchorResolver(runtime.repoRoot, access.code),
		warning: null,
	};
}
