import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingDaemon } from "@/embedding/daemon/embedding-daemon";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import {
	DAEMON_RETRY_AFTER_MS,
	SharedEmbeddingProvider,
} from "@/embedding/shared-provider";
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
	laneDepth?: number,
): EmbeddingDaemon {
	const daemon = new EmbeddingDaemon({
		socketPath: paths.socketPath,
		version,
		provider: new GemmaProvider({ workerPath: FAKE_WORKER }),
		idleTimeoutMs: 60_000,
		laneDepth,
	});
	daemon.start();
	running.push(daemon);
	return daemon;
}

function makeProvider(
	paths: DaemonPaths,
	now?: () => number,
): {
	shared: SharedEmbeddingProvider;
	direct: GemmaProvider;
} {
	const direct = new GemmaProvider({ workerPath: FAKE_WORKER });
	const shared = new SharedEmbeddingProvider(direct, {
		paths,
		spawnDaemon: false,
		now,
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

	test("an unreachable daemon is tried again once the verdict expires", async () => {
		const paths = makePaths();
		let clock = 0;
		const { shared } = makeProvider(paths, () => clock);
		await shared.embedQuery("hello");
		startDaemon(paths);

		clock = DAEMON_RETRY_AFTER_MS - 1;
		await shared.embedQuery("hello");
		expect(shared.daemonConnected).toBe(false);
		clock = DAEMON_RETRY_AFTER_MS;
		await shared.embedQuery("hello");
		expect(shared.daemonConnected).toBe(true);
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

	// H16: a daemon that refuses admission is the ladder's second rung, not an
	// error to surface — the private worker answers faster than a queue that
	// already outlives the caller's deadline.
	test("a busy daemon degrades to the private worker for that request", async () => {
		const paths = makePaths();
		startDaemon(paths, CORTEX_VERSION, 1);
		const { shared, direct } = makeProvider(paths);

		const holding = shared.embedPassages(["!slow:500"]);
		await Bun.sleep(50);
		expect([...(await shared.embedQuery("refused"))]).toEqual([7, 0, 1]);
		expect(direct.workerRunning).toBe(true);
		expect(shared.daemonConnected).toBe(true);
		await holding;
	});

	// The ladder is shared daemon → private worker → pure FTS, and a daemon
	// that dies with a request in flight must not skip the middle rung.
	test("a daemon lost mid-request falls back to the private worker", async () => {
		const paths = makePaths();
		const daemon = startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		await shared.embedQuery("warm");
		const inFlight = shared.embedPassages(["!slow:300"]);
		await Bun.sleep(50);
		daemon.stop("crashed mid-request");

		const vectors = await inFlight;
		expect(vectors.map((vector) => [...vector])).toEqual([[9, 0, 0]]);
		expect(shared.daemonConnected).toBe(false);
		expect(direct.workerRunning).toBe(true);
	});

	// A daemon that answered is a daemon that ran the model; repeating the
	// request locally would only pay for the same verdict twice.
	test("an error the daemon returned is not retried locally", async () => {
		const paths = makePaths();
		startDaemon(paths);
		const { shared, direct } = makeProvider(paths);

		expect(shared.embedPassages(["!error"])).rejects.toThrow("boom");
		await Bun.sleep(50);
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
