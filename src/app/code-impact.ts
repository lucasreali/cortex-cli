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

	// Depth 0 is the anchored files themselves: another decision governing the
	// same file is the most direct impact there is, and the import walk alone
	// starts one hop out.
	forDecision(decision: Decision, maxDepth: number): CodeImpact {
		const anchoredFiles = this.expand(decision);
		if (anchoredFiles.length === 0) return { decisions: [], truncated: false };
		const walk = this.code.transitiveImporters(anchoredFiles, maxDepth);
		const seeds: TransitiveImporter[] = anchoredFiles.map((path) => ({
			path,
			depth: 0,
			provenance: "exact",
		}));
		return {
			decisions: this.decisionsAnchoredTo(
				[...seeds, ...walk.importers],
				decision.id,
			),
			truncated: walk.truncated,
		};
	}

	private expand(decision: Decision): string[] {
		const files = decision.anchors.flatMap((anchor) => {
			if (anchor.symbol !== "" || this.code.getFile(anchor.filePath)) {
				return [anchor.filePath];
			}
			const under = this.code.listFilesUnder(anchor.filePath);
			return under.length > 0 ? under : [anchor.filePath];
		});
		return [...new Set(files)];
	}

	private decisionsAnchoredTo(
		importers: TransitiveImporter[],
		originId: string,
	): CodeImpactedDecision[] {
		if (importers.length === 0) return [];
		const byPath = new Map<string, TransitiveImporter>();
		for (const importer of importers) {
			if (!byPath.has(importer.path)) byPath.set(importer.path, importer);
		}
		const closest = new Map<string, CodeImpactedDecision>();
		const matches = this.nodes
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
		// A directory anchor matches every file under it; one entry per decision,
		// the closest, is the answer — the rest is the same fact repeated.
		for (const match of matches) {
			const known = closest.get(match.decision.id);
			if (!known || match.depth < known.depth) {
				closest.set(match.decision.id, match);
			}
		}
		return [...closest.values()].sort(
			(one, other) =>
				one.depth - other.depth || one.filePath.localeCompare(other.filePath),
		);
	}
}
