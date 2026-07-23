import { createDirectProvider } from "@/embedding/create-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { CORTEX_VERSION } from "@/version";
import { EmbeddingDaemon } from "./embedding-daemon";
import {
	acquireDaemonLock,
	clearDeadDaemonLock,
	type DaemonLock,
	isProcessAlive,
	readDaemonLock,
	releaseDaemonLock,
} from "./lock";
import { daemonPathsFor } from "./paths";

const ACQUIRE_ATTEMPTS = 5;
const ACQUIRE_RETRY_DELAY_MS = 100;

export async function runEmbeddingDaemon(modelId: string): Promise<number> {
	const paths = daemonPathsFor(modelId);
	if (
		!(await acquireWithRetries(
			paths.lockPath,
			buildLock(modelId, paths.socketPath),
		))
	) {
		console.error("[cortex daemon] another daemon holds the lock; exiting");
		return 0;
	}
	const daemon = buildDaemon(modelId, paths.socketPath);
	try {
		daemon.start();
	} catch (error) {
		releaseDaemonLock(paths.lockPath, process.pid);
		throw error;
	}
	console.error(
		`[cortex daemon] serving ${modelId} on ${paths.socketPath} (pid ${process.pid}, v${CORTEX_VERSION})`,
	);
	process.on("SIGINT", () => daemon.stop("SIGINT"));
	process.on("SIGTERM", () => daemon.stop("SIGTERM"));
	const reason = await daemon.closed;
	console.error(`[cortex daemon] stopped: ${reason}`);
	releaseDaemonLock(paths.lockPath, process.pid);
	return 0;
}

function buildDaemon(modelId: string, socketPath: string): EmbeddingDaemon {
	const workerPath = process.env.CORTEX_EMBED_WORKER_PATH;
	return new EmbeddingDaemon({
		socketPath,
		version: CORTEX_VERSION,
		provider: createDirectProvider(modelId, workerPath ? { workerPath } : {}),
		idleTimeoutMs: idleTimeoutFromEnvironment(),
	});
}

function buildLock(modelId: string, socketPath: string): DaemonLock {
	return {
		pid: process.pid,
		version: CORTEX_VERSION,
		modelId,
		socketPath,
		startedAt: Date.now(),
	};
}

async function acquireWithRetries(
	lockPath: string,
	lock: DaemonLock,
): Promise<boolean> {
	for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
		if (acquireDaemonLock(lockPath, lock)) return true;
		const holder = readDaemonLock(lockPath);
		// An unreadable lock is treated as taken, never cleared: clearing it
		// here could unlink a live daemon's lock mid-write and elect two daemons.
		if (!holder) return false;
		if (isProcessAlive(holder.pid)) return false;
		clearDeadDaemonLock(lockPath, holder.pid);
		await Bun.sleep(ACQUIRE_RETRY_DELAY_MS);
	}
	return false;
}

function idleTimeoutFromEnvironment(): number | undefined {
	const raw = process.env.CORTEX_DAEMON_IDLE_TIMEOUT_MS;
	if (raw === undefined || raw === "") return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return Math.floor(parsed);
}

if (import.meta.main) {
	process.exitCode = await runEmbeddingDaemon(
		process.argv[2] ?? GEMMA_MODEL.modelId,
	);
	process.exit();
}
