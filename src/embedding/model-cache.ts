import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errnoCode } from "@/support/errors";
import { isProcessAlive } from "./daemon/lock";
import { GEMMA_MODEL } from "./model";
import { modelsDir } from "./models-dir";

// Whether the weights are here is not a question the cache directory can
// answer: transformers.js creates the directory before the first byte lands,
// so a run killed mid-download leaves one that looks finished. The worker
// stamps this file once the extractor has actually loaded, which is the only
// moment the answer is certainly yes. It lives inside the model directory so
// deleting the model deletes the verdict with it.
// Named for the pinned revision: a cache filled from another revision is not
// the model this binary loads, and pinning one changes where transformers.js
// keeps the files, so the verdict has to move with it.
const RESIDENT_MARKER = `.cortex-model-resident-${GEMMA_MODEL.revision.slice(0, 12)}`;

// Two workers fetching the same 300 MB into one cache directory at once — two
// quick commits, or a command beside an MCP server — write the same files
// under each other. The first to start holds this; the others wait for its
// verdict instead of downloading alongside it.
const ACQUISITION_LOCK = ".cortex-model-download.lock";
const ACQUISITION_POLL_MS = 1000;

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

export interface AcquisitionOptions {
	directory?: string;
	pid?: number;
	pollMs?: number;
	deadlineMs?: number;
}

// Runs `load` with the acquisition lock held when the model is not resident
// yet. A holder that died is taken over; a live one is waited on until the
// model turns resident, the lock is released, or the deadline passes — and in
// every case `load` runs afterwards, because a cache another worker finished is
// one it reads in seconds. Nothing here may stop an embedding that would have
// worked without it, so a lock that cannot be written is no lock at all.
export async function withModelAcquisition<T>(
	load: () => Promise<T>,
	options: AcquisitionOptions = {},
): Promise<T> {
	const directory = options.directory ?? modelsDir();
	if (modelIsResident(directory)) return load();
	const lockPath = join(directory, ACQUISITION_LOCK);
	const pid = options.pid ?? process.pid;
	const deadline =
		Date.now() + (options.deadlineMs ?? MODEL_ACQUISITION_TIMEOUT_MS);
	while (!tryLock(lockPath, pid)) {
		if (modelIsResident(directory) || Date.now() >= deadline) return load();
		await Bun.sleep(options.pollMs ?? ACQUISITION_POLL_MS);
	}
	try {
		return await load();
	} finally {
		releaseLock(lockPath, pid);
	}
}

function tryLock(lockPath: string, pid: number): boolean {
	try {
		mkdirSync(dirname(lockPath), { recursive: true });
	} catch {
		return true;
	}
	try {
		writeFileSync(lockPath, String(pid), { flag: "wx" });
		return true;
	} catch (error) {
		if (errnoCode(error) !== "EEXIST") return true;
		if (holderAlive(lockPath)) return false;
		removeLock(lockPath);
		return false;
	}
}

function holderAlive(lockPath: string): boolean {
	const holder = Number(lockHolder(lockPath));
	return Number.isInteger(holder) && holder > 0 && isProcessAlive(holder);
}

function releaseLock(lockPath: string, pid: number): void {
	if (lockHolder(lockPath) === String(pid)) removeLock(lockPath);
}

function lockHolder(lockPath: string): string | null {
	try {
		return readFileSync(lockPath, "utf8");
	} catch {
		return null;
	}
}

function removeLock(lockPath: string): void {
	try {
		unlinkSync(lockPath);
	} catch {}
}
