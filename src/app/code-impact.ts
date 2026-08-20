import type { Decision, ImportProvenance } from "@/domain";
import type {
	CodeRepository,
	TransitiveImporter,
} from "@/storage/code-repository";
import type { NodeRepository } from "@/storage/node-repository";

export interface CodeImpactedDecision {
	decision: Decision;
	filePath: string;
	depth: number;
	provenance: ImportProvenance;
}

export interface CodeImpact {
	decisions: CodeImpactedDecision[];
	truncated: boolean;
}

export class CodeImpactAnalysis {
	constructor(
		private readonly nodes: NodeRepository,
		private readonly code: CodeRepository,
	) {}

	forDecision(decision: Decision, maxDepth: number): CodeImpact {
		const anchoredFiles = [
			...new Set(decision.anchors.map((anchor) => anchor.filePath)),
		];
		if (anchoredFiles.length === 0) return { decisions: [], truncated: false };
		const walk = this.code.transitiveImporters(anchoredFiles, maxDepth);
		return {
			decisions: this.decisionsAnchoredTo(walk.importers, decision.id),
			truncated: walk.truncated,
		};
	}

	private decisionsAnchoredTo(
		importers: TransitiveImporter[],
		originId: string,
	): CodeImpactedDecision[] {
		if (importers.length === 0) return [];
		const byPath = new Map(
			importers.map((importer) => [importer.path, importer]),
		);
		return this.nodes
			.listActiveAnchoredToFiles([...byPath.keys()])
			.filter((entry) => entry.decision.id !== originId)
			.flatMap((entry) => {
				const importer = byPath.get(entry.filePath);
				if (!importer) return [];
				return {
					decision: entry.decision,
					filePath: entry.filePath,
					depth: importer.depth,
					provenance: importer.provenance,
				};
			});
	}
}
