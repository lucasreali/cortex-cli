import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingDaemon } from "@/embedding/daemon/embedding-daemon";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { SharedEmbeddingProvider } from "@/embedding/shared-provider";
import { CORTEX_VERSION } from "@/version";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

const running: EmbeddingDaemon[] = [];
const providers: SharedEmbeddingProvider[] = [];

function makePaths(): DaemonPaths {
	return daemonPathsFor(
		GEMMA_MODEL.modelId,
		mkdtempSync(join(tmpdir(), "cortex-shared-")),
	);
}

function startDaemon(
	paths: DaemonPaths,
	version = CORTEX_VERSION,
): EmbeddingDaemon {
	const daemon = new EmbeddingDaemon({
		socketPath: paths.socketPath,
		version,
		provider: new GemmaProvider({ workerPath: FAKE_WORKER }),
		idleTimeoutMs: 60_000,
	});
	daemon.start();
	running.push(daemon);
	return daemon;
}

function makeProvider(paths: DaemonPaths): {
	shared: SharedEmbeddingProvider;
	direct: GemmaProvider;
} {
	const direct = new GemmaProvider({ workerPath: FAKE_WORKER });
	const shared = new SharedEmbeddingProvider(direct, {
		paths,
		spawnDaemon: false,
	});
	providers.push(shared);
	return { shared, direct };
}

afterEach(() => {
	for (const provider of providers.splice(0)) {
		provider.dispose();
	}
	for (const daemon of running.splice(0)) {
		daemon.stop("test teardown");
	}
});

describe("SharedEmbeddingProvider", () => {
	test("embeds through the daemon and never spawns its own worker", async () => {
		const paths = makePaths();
		startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		expect([...(await shared.embedQuery("hello"))]).toEqual([5, 0, 1]);
		const passages = await shared.embedPassages(["ab", "cdef"]);
		expect(passages.map((vector) => [...vector])).toEqual([
			[2, 0, 0],
			[4, 1, 0],
		]);
		expect(shared.daemonConnected).toBe(true);
		expect(direct.workerRunning).toBe(false);
	});

	test("falls back to the private worker when no daemon can be reached", async () => {
		const { shared, direct } = makeProvider(makePaths());
		expect([...(await shared.embedQuery("hello"))]).toEqual([5, 0, 1]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(true);
	});

	test("falls back when the daemon speaks another version", async () => {
		const paths = makePaths();
		startDaemon(paths, "9.9.9-other");
		const { shared, direct } = makeProvider(paths);
		expect([...(await shared.embedQuery("hello"))]).toEqual([5, 0, 1]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(true);
	});

	test("a daemon spawn that cannot start degrades to the private worker", async () => {
		const blocker = join(mkdtempSync(join(tmpdir(), "cortex-shared-")), "file");
		writeFileSync(blocker, "");
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, join(blocker, "daemon"));
		const direct = new GemmaProvider({ workerPath: FAKE_WORKER });
		const shared = new SharedEmbeddingProvider(direct, { paths });
		providers.push(shared);

		expect([...(await shared.embedQuery("hello"))]).toEqual([5, 0, 1]);
		expect([...(await shared.embedQuery("again"))]).toEqual([5, 0, 1]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(true);
	});

	test("empty passages never touch daemon or worker", async () => {
		const paths = makePaths();
		startDaemon(paths);
		const { shared, direct } = makeProvider(paths);
		expect(await shared.embedPassages([])).toEqual([]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(false);
	});

	test("a daemon lost mid-session degrades to the private worker", async () => {
		const paths = makePaths();
		const daemon = startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		await shared.embedQuery("warm");
		expect(shared.daemonConnected).toBe(true);
		daemon.stop("gone");
		await Bun.sleep(50);

		expect([...(await shared.embedQuery("after"))]).toEqual([5, 0, 1]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(true);
	});

	test("reconnects when a daemon is back after a drop", async () => {
		const paths = makePaths();
		const first = startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		await shared.embedQuery("warm");
		first.stop("restarting");
		await Bun.sleep(50);
		startDaemon(paths);

		expect([...(await shared.embedQuery("back"))]).toEqual([4, 0, 1]);
		expect(shared.daemonConnected).toBe(true);
		expect(direct.workerRunning).toBe(false);
	});

	test("dispose releases the daemon connection and the private worker", async () => {
		const paths = makePaths();
		const daemon = startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		await shared.embedQuery("warm");
		expect(daemon.clientCount).toBe(1);
		shared.dispose();
		await Bun.sleep(50);
		expect(daemon.clientCount).toBe(0);
		expect(direct.workerRunning).toBe(false);
	});
});
