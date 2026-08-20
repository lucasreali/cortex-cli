import type { Anchor } from "@/domain";

// `anchors` is keyed by (node_id, file_path, symbol), and a decision file is
// human-readable and git-merged: a hand edit or a merge that duplicates a list
// entry can name the same anchor twice without changing what the decision
// says. A repeated anchor carries nothing the first one does not, so it is
// collapsed on the way in — on the save path, where the file is immutable once
// written, and on the parse path, where the file arrived that way already.
export function uniqueAnchors(anchors: Anchor[]): Anchor[] {
	const byKey = new Map(anchors.map((anchor) => [keyOf(anchor), anchor]));
	return [...byKey.values()];
}

// Not `path#symbol`: a path may legitimately contain a `#`, and the primary
// key this guards is the pair, not the joined text.
function keyOf(anchor: Anchor): string {
	return JSON.stringify([anchor.filePath, anchor.symbol]);
}
