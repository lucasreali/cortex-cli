import { errorMessage } from "@/support/errors";
import { parseJsonOrNull } from "@/support/json";
import type { EmbedKind, WorkerRequest, WorkerResponse } from "./protocol";

interface PendingVectors {
	resolve(vectors: number[][]): void;
	reject(error: Error): void;
}

type SendRequest = (request: WorkerRequest) => void;

// Nothing outside the ledger guarantees that a dispatched request settles, so
// the ledger owns the write too: a peer can die between a caller's liveness
// check and its write, and an entry recorded after rejectAll drained the map
// would hang until an outer timeout — or forever, on a path that has none.
export class VectorRequestLedger {
	private readonly pending: Map<number, PendingVectors>;
	private nextRequestId: number;
	private closure: Error | null;

	constructor() {
		this.pending = new Map();
		this.nextRequestId = 1;
		this.closure = null;
	}

	dispatch(
		kind: EmbedKind,
		texts: string[],
		send: SendRequest,
	): Promise<number[][]> {
		if (this.closure) return Promise.reject(this.closure);
		const request: WorkerRequest = { id: this.nextRequestId++, kind, texts };
		const vectors = new Promise<number[][]>((resolve, reject) => {
			this.pending.set(request.id, { resolve, reject });
		});
		this.write(request, send);
		return vectors;
	}

	settle(line: string): void {
		const response = parseJsonOrNull<WorkerResponse>(line);
		if (!response) return;
		if ("error" in response) {
			this.fail(response.id, new Error(response.error));
			return;
		}
		this.take(response.id)?.resolve(response.vectors);
	}

	rejectAll(error: Error): void {
		this.closure = error;
		for (const id of [...this.pending.keys()]) {
			this.fail(id, error);
		}
	}

	private write(request: WorkerRequest, send: SendRequest): void {
		try {
			send(request);
		} catch (error) {
			this.fail(request.id, new Error(errorMessage(error)));
		}
	}

	private fail(id: number, error: Error): void {
		this.take(id)?.reject(error);
	}

	private take(id: number): PendingVectors | null {
		const entry = this.pending.get(id);
		if (!entry) return null;
		this.pending.delete(id);
		return entry;
	}
}
