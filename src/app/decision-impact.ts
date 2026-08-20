import type { Decision } from "@/domain";
import { CodeImpactAnalysis, type CodeImpactedDecision } from "./code-impact";
import { accessCodeIndex } from "./code-index-access";
import type { CortexRuntime } from "./runtime";

export interface ImpactedDecision {
	node: Decision;
	depth: number;
}

export interface DecisionImpact {
	root: Decision;
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

type ImpactDependencies = Pick<CortexRuntime, "nodes" | "edges" | "codeIndex">;

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
	const code = await codeImpact(
		runtime,
		root,
		depths.codeDepth ?? DEFAULT_IMPACT_DEPTH,
	);
	return { root, impacted, ...code };
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

type CodeSide = Pick<
	DecisionImpact,
	"codeImpacted" | "codeTruncated" | "codeWarning"
>;

const NO_CODE_IMPACT: CodeSide = {
	codeImpacted: [],
	codeTruncated: false,
	codeWarning: null,
};

async function codeImpact(
	runtime: ImpactDependencies,
	root: Decision,
	depth: number,
): Promise<CodeSide> {
	if (root.anchors.length === 0) return NO_CODE_IMPACT;
	const access = await accessCodeIndex(runtime.codeIndex);
	if (!access.ok) {
		return { ...NO_CODE_IMPACT, codeWarning: access.warning };
	}
	const impact = new CodeImpactAnalysis(runtime.nodes, access.code).forDecision(
		root,
		depth,
	);
	return {
		codeImpacted: impact.decisions,
		codeTruncated: impact.truncated,
		codeWarning: null,
	};
}
