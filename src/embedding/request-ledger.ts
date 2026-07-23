import type { EmbedKind, WorkerRequest, WorkerResponse } from "./protocol";

interface PendingVectors {
	resolve(vectors: number[][]): void;
	reject(error: Error): void;
}

export interface OpenedRequest {
	request: WorkerRequest;
	vectors: Promise<number[][]>;
}

export class VectorRequestLedger {
	private readonly pending: Map<number, PendingVectors>;
	private nextRequestId: number;

	constructor() {
		this.pending = new Map();
		this.nextRequestId = 1;
	}

	open(kind: EmbedKind, texts: string[]): OpenedRequest {
		const request: WorkerRequest = { id: this.nextRequestId++, kind, texts };
		const vectors = new Promise<number[][]>((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
		});
		return { request, vectors };
	}

	settle(line: string): void {
		const response = decodeResponse(line);
		if (!response) return;
		const entry = this.pending.get(response.id);
		if (!entry) return;
		this.pending.delete(response.id);
		if ("error" in response) {
			entry.reject(new Error(response.error));
			return;
		}
		entry.resolve(response.vectors);
	}

	rejectAll(error: Error): void {
		for (const entry of this.pending.values()) {
			entry.reject(error);
		}
		this.pending.clear();
	}
}

function decodeResponse(line: string): WorkerResponse | null {
	try {
		return JSON.parse(line) as WorkerResponse;
	} catch {
		return null;
	}
}
