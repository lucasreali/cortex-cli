import type { EmbedKind } from "./protocol";
import type { EmbeddingProvider } from "./provider";

type EmbedBatch = (kind: EmbedKind, texts: string[]) => Promise<Float32Array[]>;

// Both providers answer embedQuery and embedPassages the same way — the only
// thing that differs is where a non-empty batch is sent, which each supplies
// to the constructor. The empty-input short circuit stays here so neither can
// forget it and spawn a worker (or dial the daemon) for nothing.
export class KindEmbeddingProvider implements EmbeddingProvider {
	constructor(
		readonly modelId: string,
		private readonly embedBatch: EmbedBatch,
	) {}

	async embedQuery(text: string): Promise<Float32Array> {
		const [vector] = await this.embed("query", [text]);
		if (!vector) throw new Error("embedding worker returned no vector");
		return vector;
	}

	embedPassages(texts: string[]): Promise<Float32Array[]> {
		return this.embed("passages", texts);
	}

	embed(kind: EmbedKind, texts: string[]): Promise<Float32Array[]> {
		if (texts.length === 0) return Promise.resolve([]);
		return this.embedBatch(kind, texts);
	}
}
