import type { ResolvedAnchor } from "@/app/anchor-confidence";

// A file-level anchor has no symbol, and an empty string repeated on every
// anchor of every result is context an agent pays for and learns nothing from.
export function anchorEntry(anchor: ResolvedAnchor) {
	return {
		filePath: anchor.filePath,
		...(anchor.symbol === "" ? {} : { symbol: anchor.symbol }),
		confidence: anchor.confidence,
	};
}

export function anchorEntries(anchors: ResolvedAnchor[] | undefined) {
	return (anchors ?? []).map(anchorEntry);
}
