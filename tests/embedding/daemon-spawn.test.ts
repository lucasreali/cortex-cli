import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDaemon } from "@/embedding/daemon/client";
import {
	isProcessAlive,
	REUSED_PID_LOCK_AGE_MS,
	readDaemonLock,
} from "@/embedding/daemon/lock";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import {
	SharedEmbeddingProvider,
	type SharedEmbeddingProviderOptions,
} from "@/embedding/shared-provider";
import { CORTEX_VERSION } from "@/version";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

const spawnedDirs: DaemonPaths[] = [];
const providers: SharedEmbeddingProvider[] = [];

function makePaths(): DaemonPaths {
	const paths = daemonPathsFor(
		GEMMA_MODEL.modelId,
		mkdtempSync(join(tmpdir(), "cortex-spawn-")),
	);
	spawnedDirs.push(paths);
	return paths;
}

function makeProvider(paths: DaemonPaths): SharedEmbeddingProvider {
	const options: SharedEmbeddingProviderOptions = {
		paths,
		daemonWorkerPath: FAKE_WORKER,
		daemonIdleTimeoutMs: 5000,
	};
	const provider = new SharedEmbeddingProvider(
		new GemmaProvider({ workerPath: FAKE_WORKER }),
		options,
	);
	providers.push(provider);
	return provider;
}

async function terminateDaemon(paths: DaemonPaths): Promise<void> {
	const lock = readDaemonLock(paths.lockPath);
	if (!lock) return;
	try {
		process.kill(lock.pid, "SIGTERM");
	} catch {
		return;
	}
	for (let attempt = 0; attempt < 40 && isProcessAlive(lock.pid); attempt++) {
		await Bun.sleep(50);
	}
}

afterEach(async () => {
	for (const provider of providers.splice(0)) {
		provider.dispose();
	}
	for (const paths of spawnedDirs.splice(0)) {
		await terminateDaemon(paths);
	}
});

describe("detached daemon spawn (e2e)", () => {
	test("first embed spawns the daemon; a second session reuses it", async () => {
		const paths = makePaths();
		const first = makeProvider(paths);
		expect([...(await first.embedQuery("hello"))]).toEqual([5, 0, 1]);
		expect(first.daemonConnected).toBe(true);

		const lock = readDaemonLock(paths.lockPath);
		expect(lock).not.toBeNull();
		expect(lock?.pid).not.toBe(process.pid);
		expect(isProcessAlive(lock?.pid ?? -1)).toBe(true);

		const second = makeProvider(paths);
		expect([...(await second.embedQuery("shared!"))]).toEqual([7, 0, 1]);
		expect(second.daemonConnected).toBe(true);

		const probe = await probeDaemon({
			paths,
			version: CORTEX_VERSION,
			modelId: GEMMA_MODEL.modelId,
		});
		if (probe.status !== "connected") {
			throw new Error(`expected connection, got ${probe.status}`);
		}
		expect(probe.connection.hello.pid).toBe(lock?.pid ?? -1);
		probe.connection.close();
	}, 15_000);

	test("racing cold starts converge on a single daemon", async () => {
		const paths = makePaths();
		const left = makeProvider(paths);
		const right = makeProvider(paths);

		const [fromLeft, fromRight] = await Promise.all([
			left.embedQuery("aa"),
			right.embedQuery("bbb"),
		]);
		expect([...fromLeft]).toEqual([2, 0, 1]);
		expect([...fromRight]).toEqual([3, 0, 1]);

		const lock = readDaemonLock(paths.lockPath);
		expect(lock).not.toBeNull();
		expect(left.daemonConnected || right.daemonConnected).toBe(true);
	}, 15_000);

	// H17: the lock records "some process has this pid", which after a kill -9
	// or a reboot is eventually an unrelated one. Every daemon then refused to
	// start and the whole machine ran private-worker-only until a human
	// deleted the file.
	test("a lock whose pid was reused is reclaimed by the next daemon", async () => {
		const paths = makePaths();
		mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
		writeFileSync(
			paths.lockPath,
			JSON.stringify({
				pid: process.pid,
				version: CORTEX_VERSION,
				modelId: GEMMA_MODEL.modelId,
				socketPath: paths.socketPath,
				startedAt: Date.now() - REUSED_PID_LOCK_AGE_MS - 1,
			}),
		);

		const provider = makeProvider(paths);
		expect([...(await provider.embedQuery("hello"))]).toEqual([5, 0, 1]);
		expect(provider.daemonConnected).toBe(true);
		expect(readDaemonLock(paths.lockPath)?.pid).not.toBe(process.pid);
	}, 15_000);

	// L10: the daemon appends its whole life to this file, the worker's
	// model-download progress included, and nothing else ever prunes it.
	test("an oversized daemon log is truncated at spawn", async () => {
		const paths = makePaths();
		mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
		writeFileSync(paths.logPath, "old\n".repeat(300_000));
		expect(statSync(paths.logPath).size).toBeGreaterThan(1024 * 1024);

		await makeProvider(paths).embedQuery("warm");
		expect(statSync(paths.logPath).size).toBeLessThan(1024 * 1024);
	}, 15_000);

	test("SIGTERM cleans up the socket and the lock", async () => {
		const paths = makePaths();
		const provider = makeProvider(paths);
		await provider.embedQuery("warm");
		provider.dispose();

		await terminateDaemon(paths);
		expect(readDaemonLock(paths.lockPath)).toBeNull();
		expect(existsSync(paths.socketPath)).toBe(false);
	}, 15_000);
});
