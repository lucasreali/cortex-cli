import type { pipeline as pipelineType } from "@huggingface/transformers";
import { GEMMA_MODEL } from "./model";
import { modelsDir } from "./models-dir";
import { encodeNdjson, LineBuffer } from "./ndjson";
import { ensureOnnxRuntimeAssets } from "./onnxruntime-assets";
import {
	decodeRequest,
	type WorkerRequest,
	type WorkerResponse,
} from "./protocol";

type Extractor = Awaited<ReturnType<typeof pipelineType<"feature-extraction">>>;

let extractorPromise: Promise<Extractor> | null = null;

function loadExtractor(): Promise<Extractor> {
	extractorPromise ??= createExtractor();
	return extractorPromise;
}

async function createExtractor(): Promise<Extractor> {
	// transformers.js v4 picks the native onnxruntime-node backend when
	// process.release.name === "node" — and Bun reports itself as "node".
	// Renaming before the import forces the web (WASM) backend; native
	// dependencies are banned because the compiled single-file binary
	// cannot ship platform-specific .node addons.
	process.release.name = "bun";
	const { pipeline, env } = await import("@huggingface/transformers");
	if (!env.backends.onnx?.wasm) {
		throw new Error("onnxruntime WASM backend unavailable");
	}
	env.cacheDir = modelsDir();
	env.backends.onnx.wasm.wasmPaths = `${Bun.pathToFileURL(await ensureOnnxRuntimeAssets()).href}/`;
	// More than 1 thread does not work in Bun: Emscripten's pthread workers
	// are loaded via blob URL, which Bun's worker_threads cannot resolve.
	env.backends.onnx.wasm.numThreads = 1;
	// q8 is mandatory: q4 uses GatherBlockQuantized, which the wasm
	// execution provider does not implement.
	return pipeline("feature-extraction", GEMMA_MODEL.huggingFaceId, {
		device: "wasm",
		dtype: "q8",
	});
}

async function embed(request: WorkerRequest): Promise<number[][]> {
	const prefix =
		request.kind === "query"
			? GEMMA_MODEL.queryPrefix
			: GEMMA_MODEL.documentPrefix;
	const extractor = await loadExtractor();
	const output = (await extractor(
		request.texts.map((text) => prefix + text),
		{ pooling: "mean", normalize: true },
	)) as { dims: number[]; data: Float32Array };
	return sliceRows(output).map((row) =>
		Array.from(truncateAndNormalize(row, GEMMA_MODEL.dims)),
	);
}

function sliceRows(output: {
	dims: number[];
	data: Float32Array;
}): Float32Array[] {
	const [rows = 0, dims = 0] = output.dims;
	return Array.from({ length: rows }, (_, index) =>
		output.data.slice(index * dims, (index + 1) * dims),
	);
}

function truncateAndNormalize(
	vector: Float32Array,
	dims: number,
): Float32Array {
	const truncated = vector.slice(0, dims);
	let sumOfSquares = 0;
	for (const value of truncated) {
		sumOfSquares += value * value;
	}
	const norm = Math.sqrt(sumOfSquares);
	return truncated.map((value) => value / norm);
}

function respond(response: WorkerResponse): void {
	process.stdout.write(encodeNdjson(response));
}

async function handleLine(line: string): Promise<void> {
	const request = decodeRequest(line);
	if (!request) return;
	try {
		respond({ id: request.id, vectors: await embed(request) });
	} catch (error) {
		respond({ id: request.id, error: String(error) });
	}
}

export async function runEmbedWorker(): Promise<void> {
	const lines = new LineBuffer();
	for await (const chunk of Bun.stdin.stream()) {
		for (const line of lines.push(chunk)) {
			await handleLine(line);
		}
	}
}

if (import.meta.main) {
	await runEmbedWorker();
}
