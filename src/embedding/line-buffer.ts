export class LineBuffer {
	private readonly decoder = new TextDecoder();
	private buffered = "";

	push(chunk: Uint8Array | string): string[] {
		this.buffered +=
			typeof chunk === "string"
				? chunk
				: this.decoder.decode(chunk, { stream: true });
		const lines = this.buffered.split("\n");
		this.buffered = lines.pop() ?? "";
		return lines.map((line) => line.trim()).filter((line) => line.length > 0);
	}
}
