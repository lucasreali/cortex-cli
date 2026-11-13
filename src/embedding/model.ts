export const GEMMA_MODEL = {
	modelId: "embeddinggemma-300m-q8@256",
	huggingFaceId: "onnx-community/embeddinggemma-300m-ONNX",
	// A commit, never "main": the worker imports an ONNX runtime module and
	// loads weights fetched from this repository, and a moving branch would let
	// whoever controls it change what every installed cortex executes.
	revision: "5090578d9565bb06545b4552f76e6bc2c93e4a66",
	dims: 256,
	queryPrefix: "task: search result | query: ",
	documentPrefix: "title: none | text: ",
} as const;
