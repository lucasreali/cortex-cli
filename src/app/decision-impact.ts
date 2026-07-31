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
	const root = runtime.nodes.getById(decisionId);
	if (!root) return null;
	const impacted = runtime.edges
		.getImpact(decisionId, depths.maxDepth ?? DEFAULT_IMPACT_DEPTH)
		.flatMap(({ nodeId, depth }) => {
			const node = runtime.nodes.getById(nodeId);
			return node ? [{ node, depth }] : [];
		});
	const code = await codeImpact(
		runtime,
		root,
		depths.codeDepth ?? DEFAULT_IMPACT_DEPTH,
	);
	return { root, impacted, ...code };
}

async function codeImpact(
	runtime: ImpactDependencies,
	root: Decision,
	depth: number,
): Promise<Pick<DecisionImpact, "codeImpacted" | "codeWarning">> {
	if (root.anchors.length === 0) {
		return { codeImpacted: [], codeWarning: null };
	}
	const access = await accessCodeIndex(runtime.codeIndex);
	if (!access.ok) {
		return { codeImpacted: [], codeWarning: access.warning };
	}
	const analysis = new CodeImpactAnalysis(runtime.nodes, access.code);
	return {
		codeImpacted: analysis.forDecision(root, depth),
		codeWarning: null,
	};
}
