export interface EmbeddingProvider {
	modelId: string;
	embedQuery(text: string): Promise<Float32Array>;
	embedPassages(texts: string[]): Promise<Float32Array[]>;
	dispose?(): void;
}
