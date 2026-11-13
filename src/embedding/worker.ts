import type { pipeline as pipelineType } from "@huggingface/transformers";
import { DownloadProgress } from "./download-progress";
import { GEMMA_MODEL } from "./model";
import {
	markModelResident,
	modelIsResident,
	withModelAcquisition,
} from "./model-cache";
import { modelsDir } from "./models-dir";
import { encodeNdjson, LineBuffer } from "./ndjson";
import { ensureOnnxRuntimeAssets } from "./onnxruntime-assets";
import {
	decodeRequest,
	type WorkerRequest,
	type WorkerResponse,
} from "./protocol";
import { RetainedLoad } from "./retained-load";

type Extractor = Awaited<ReturnType<typeof pipelineType<"feature-extraction">>>;

const extractor = new RetainedLoad(createExtractor);

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
	// transformers.js reports the same progress for a file it streams out of
	// the cache as for one it fetches, so the only honest moment to narrate is
	// the one where the model is not here yet — which is also the only run
	// long enough for silence to read as a hang.
	const progress = modelIsResident() ? null : new DownloadProgress();
	// q8 is mandatory: q4 uses GatherBlockQuantized, which the wasm
	// execution provider does not implement.
	return withModelAcquisition(async () => {
		const loaded = await pipeline(
			"feature-extraction",
			GEMMA_MODEL.huggingFaceId,
			{
				device: "wasm",
				dtype: "q8",
				revision: GEMMA_MODEL.revision,
				progress_callback: (event) => reportProgress(progress, event),
			},
		);
		markModelResident();
		return loaded;
	});
}

function reportProgress(
	progress: DownloadProgress | null,
	event: unknown,
): void {
	const line = progress?.line(event as { file?: string });
	if (line) process.stderr.write(`${line}\n`);
}

async function embed(request: WorkerRequest): Promise<number[][]> {
	const prefix =
		request.kind === "query"
			? GEMMA_MODEL.queryPrefix
			: GEMMA_MODEL.documentPrefix;
	const loaded = await extractor.get();
	const output = (await loaded(
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
