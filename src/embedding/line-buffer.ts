// A peer that never sends a newline would otherwise grow the buffer without
// limit. The cap is far above any real request: the largest one is a batch of
// decision passages, and a line beyond this is a stuck or hostile writer.
const MAX_PENDING_LINE_LENGTH = 8 * 1024 * 1024;

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
		if (this.buffered.length > MAX_PENDING_LINE_LENGTH) {
			this.buffered = "";
			throw new Error("line exceeds the maximum length without a newline");
		}
		return lines.map((line) => line.trim()).filter((line) => line.length > 0);
	}
}
