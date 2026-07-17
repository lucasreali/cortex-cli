export type EmbedKind = "query" | "passages";

export interface WorkerRequest {
	id: number;
	kind: EmbedKind;
	texts: string[];
}

export type WorkerResponse =
	| { id: number; vectors: number[][] }
	| { id: number; error: string };
