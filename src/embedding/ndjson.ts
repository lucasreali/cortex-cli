// One end of the NDJSON framing both peers speak: every message is a single
// JSON line. LineBuffer is the other end, reassembling those lines from
// whatever chunk sizes the socket or pipe happens to deliver.
export function encodeNdjson(message: unknown): string {
	return `${JSON.stringify(message)}\n`;
}

// A peer that never sends a newline would otherwise grow the buffer without
// limit. The cap is far above any real request: the largest one is a batch of
// decision passages, and a line beyond this is a stuck or hostile writer.
const MAX_PENDING_LINE_LENGTH = 8 * 1024 * 1024;

// The lines that did arrive whole are still answerable, and the same chunk that
// overruns the cap can carry them, so they travel with the failure instead of
// being thrown away with the writer.
export class OverlongLineError extends Error {
	constructor(readonly completed: string[]) {
		super("line exceeds the maximum length without a newline");
	}
}

export class LineBuffer {
	private readonly decoder: TextDecoder;
	private buffered: string;

	constructor() {
		this.decoder = new TextDecoder();
		this.buffered = "";
	}

	push(chunk: Uint8Array | string): string[] {
		this.buffered +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		const lines = this.buffered.split("\n");
		this.buffered = lines.pop() ?? "";
		const completed = lines
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (this.buffered.length > MAX_PENDING_LINE_LENGTH) {
			this.buffered = "";
			throw new OverlongLineError(completed);
		}
		return completed;
	}
}

export function linesSalvagedFrom(error: unknown): string[] {
	return error instanceof OverlongLineError ? error.completed : [];
}
