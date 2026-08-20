import type { AnchorConfidence } from "@/domain";
import { style } from "./style";

// Only the strong label is quiet: a reader scanning anchors should see the
// weak ones, not have to notice the absence of a marker.
export function confidenceTag(confidence: AnchorConfidence): string {
	if (confidence === "exact") return style.dim("[exact]");
	return style.yellow(`[${confidence}]`);
}
