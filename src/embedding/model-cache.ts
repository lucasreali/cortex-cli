import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GEMMA_MODEL } from "./model";
import { modelsDir } from "./models-dir";

// Whether the weights are here is not a question the cache directory can
// answer: transformers.js creates the directory before the first byte lands,
// so a run killed mid-download leaves one that looks finished. The worker
// stamps this file once the extractor has actually loaded, which is the only
// moment the answer is certainly yes. It lives inside the model directory so
// deleting the model deletes the verdict with it.
const RESIDENT_MARKER = ".cortex-model-resident";

// The first run fetches roughly 300 MB. A worker doing that is not a wedged
// worker, and the embed deadline exists to catch the second — so until the
// model is resident the deadline is replaced by a budget an acquisition can
// plausibly finish inside. It stays bounded: a download that is genuinely
// stuck is still reported rather than waited on forever.
export const MODEL_ACQUISITION_TIMEOUT_MS = 900_000;

export function modelCacheDirectory(directory: string = modelsDir()): string {
	return join(directory, GEMMA_MODEL.huggingFaceId);
}

export function modelIsResident(directory: string = modelsDir()): boolean {
	return existsSync(join(modelCacheDirectory(directory), RESIDENT_MARKER));
}

// Best effort by design: a read-only or full models directory costs the next
// run its deadline shortcut, never the embedding that just succeeded.
export function markModelResident(directory: string = modelsDir()): void {
	const target = modelCacheDirectory(directory);
	try {
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, RESIDENT_MARKER), `${GEMMA_MODEL.modelId}\n`);
	} catch {}
}

// A provider that cannot say whether its model is resident is taken at the
// configured deadline: only the one that spawns the download knows there is
// one to wait for.
export function embedDeadlineMs(
	provider: { modelResident?(): boolean },
	inferenceTimeoutMs: number,
): number {
	if (provider.modelResident?.() !== false) return inferenceTimeoutMs;
	return Math.max(inferenceTimeoutMs, MODEL_ACQUISITION_TIMEOUT_MS);
}
