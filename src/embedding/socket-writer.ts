export interface WritableSocket {
	write(data: Uint8Array): number;
}

// Bun's socket write accepts fewer bytes than it is given once the kernel
// buffer fills, and the tail it refused is not retried for us. Dropping it
// would truncate one NDJSON line and glue its remainder onto the next, losing
// two messages instead of one, so the remainder is held here and re-offered
// from the socket's `drain` event.
//
// Bytes, not characters: the socket counts what it took in bytes, which slices
// a multi-byte character in half if the pending tail is kept as a string.
export class SocketWriter {
	private pending: Uint8Array<ArrayBufferLike>;

	constructor() {
		this.pending = new Uint8Array(0);
	}

	write(socket: WritableSocket, message: string): void {
		this.pending = concat(this.pending, new TextEncoder().encode(message));
		this.flush(socket);
	}

	// A socket that throws here has already gone; every open request is settled
	// by the close handler, which is the layer that owes them an answer.
	flush(socket: WritableSocket): void {
		if (this.pending.length === 0) return;
		try {
			const written = socket.write(this.pending);
			if (written > 0) this.pending = this.pending.subarray(written);
		} catch {
			this.pending = new Uint8Array(0);
		}
	}
}

function concat(head: Uint8Array, tail: Uint8Array<ArrayBuffer>): Uint8Array {
	if (head.length === 0) return tail;
	const joined = new Uint8Array(head.length + tail.length);
	joined.set(head);
	joined.set(tail, head.length);
	return joined;
}
