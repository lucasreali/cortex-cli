export type EmbedKind = "query" | "passages";

export interface WorkerRequest {
	id: number;
	kind: EmbedKind;
	texts: string[];
}

export type WorkerResponse =
	| { id: number; vectors: number[][] }
	| { id: number; error: string };

// A peer that sends a line we cannot answer gets no answer: replying to an
// unknown id would settle someone else's request, and throwing would take the
// whole worker down over one bad line.
export function decodeRequest(line: string): WorkerRequest | null {
	try {
		const parsed = JSON.parse(line) as Partial<WorkerRequest>;
		if (typeof parsed?.id !== "number") return null;
		if (parsed.kind !== "query" && parsed.kind !== "passages") return null;
		if (!Array.isArray(parsed.texts)) return null;
		return parsed as WorkerRequest;
	} catch {
		return null;
	}
}
