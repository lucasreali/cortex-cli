import type { Decision, ImportProvenance } from "@/domain";
import type { CodeRepository, TransitiveImporter } from "./code-repository";
import type { NodeRepository } from "./node-repository";

export interface CodeImpactedDecision {
	decision: Decision;
	filePath: string;
	depth: number;
	provenance: ImportProvenance;
}

export class CodeImpactAnalysis {
	constructor(
		private readonly nodes: NodeRepository,
		private readonly code: CodeRepository,
	) {}

	forDecision(decision: Decision, maxDepth: number): CodeImpactedDecision[] {
		const anchoredFiles = [
			...new Set(decision.anchors.map((anchor) => anchor.filePath)),
		];
		if (anchoredFiles.length === 0) return [];
		const importers = this.code.transitiveImporters(anchoredFiles, maxDepth);
		if (importers.length === 0) return [];
		return this.decisionsAnchoredTo(importers, decision.id);
	}

	private decisionsAnchoredTo(
		importers: TransitiveImporter[],
		originId: string,
	): CodeImpactedDecision[] {
		const byPath = new Map(
			importers.map((importer) => [importer.path, importer]),
		);
		return this.nodes
			.listActiveAnchoredToFiles([...byPath.keys()])
			.filter((entry) => entry.decision.id !== originId)
			.map((entry) => {
				// The anchor path came out of byPath's own keys, so the lookup
				// always hits.
				const importer = byPath.get(entry.filePath) as TransitiveImporter;
				return {
					decision: entry.decision,
					filePath: entry.filePath,
					depth: importer.depth,
					provenance: importer.provenance,
				};
			});
	}
}
