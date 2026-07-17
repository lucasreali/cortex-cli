export const GEMMA_MODEL = {
	modelId: "embeddinggemma-300m-q8@256",
	huggingFaceId: "onnx-community/embeddinggemma-300m-ONNX",
	dims: 256,
	queryPrefix: "task: search result | query: ",
	documentPrefix: "title: none | text: ",
} as const;
