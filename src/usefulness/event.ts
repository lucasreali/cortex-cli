import { parseJsonOrNull } from "@/support/json";

export type UsefulnessKind = "shown" | "used";

export interface UsefulnessEvent {
	session: string;
	decision: string;
	kind: UsefulnessKind;
	at: string;
}

export function encodeEvent(event: UsefulnessEvent): string {
	return `${JSON.stringify(event)}\n`;
}

// A malformed line is dropped rather than condemning the file: the lines around
// it are still every signal this machine gathered. Corruption is a fact about
// one row here, never about the whole log.
export function decodeEvents(text: string): UsefulnessEvent[] {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => parseJsonOrNull<UsefulnessEvent>(line))
		.filter(isEvent);
}

function isEvent(value: UsefulnessEvent | null): value is UsefulnessEvent {
	if (value === null) return false;
	return (
		typeof value.session === "string" &&
		typeof value.decision === "string" &&
		(value.kind === "shown" || value.kind === "used") &&
		typeof value.at === "string" &&
		!Number.isNaN(Date.parse(value.at))
	);
}
