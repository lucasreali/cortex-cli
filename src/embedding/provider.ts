export interface EmbeddingProvider {
	modelId: string;
	embedQuery(text: string): Promise<Float32Array>;
	embedPassages(texts: string[]): Promise<Float32Array[]>;
	// Answered only by a provider that owns the model cache, so that the caller
	// can tell an embed that has to fetch 300 MB first from one that does not.
	modelResident?(): boolean;
	dispose?(): void;
}
