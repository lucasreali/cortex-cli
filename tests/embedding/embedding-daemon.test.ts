import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DaemonConnection,
	type DaemonEndpoint,
	listenerProbe,
	probeDaemon,
} from "@/embedding/daemon/client";
import { EmbeddingDaemon } from "@/embedding/daemon/embedding-daemon";
import type { DaemonLock } from "@/embedding/daemon/lock";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { markModelResident } from "@/embedding/model-cache";
import { DAEMON_BUSY } from "@/embedding/protocol";
import { CORTEX_VERSION } from "@/version";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

interface Harness {
	daemon: EmbeddingDaemon;
	endpoint: DaemonEndpoint;
	provider: GemmaProvider;
	socketPath: string;
}

// The fake worker downloads nothing, but the deadline the daemon applies now
// depends on whether the model is resident — so each harness gets its own
// models directory and says which of the two cases it is testing.
function modelsDirectory(resident: boolean): string {
	const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-models-"));
	if (resident) markModelResident(directory);
	return directory;
}

const running: EmbeddingDaemon[] = [];

function makeDaemon(
	overrides: {
		idleTimeoutMs?: number;
		requestTimeoutMs?: number;
		version?: string;
		laneDepth?: number;
		modelResident?: boolean;
	} = {},
): Harness {
	const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
	const paths = daemonPathsFor(GEMMA_MODEL.modelId, directory);
	const version = overrides.version ?? CORTEX_VERSION;
	const provider = new GemmaProvider({
		workerPath: FAKE_WORKER,
		modelsDir: modelsDirectory(overrides.modelResident !== false),
	});
	const daemon = new EmbeddingDaemon({
		socketPath: paths.socketPath,
		version,
		provider,
		idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
		requestTimeoutMs: overrides.requestTimeoutMs,
		laneDepth: overrides.laneDepth,
	});
	daemon.start();
	running.push(daemon);
	return {
		daemon,
		provider,
		socketPath: paths.socketPath,
		endpoint: { paths, version: CORTEX_VERSION, modelId: GEMMA_MODEL.modelId },
	};
}

async function connect(endpoint: DaemonEndpoint): Promise<DaemonConnection> {
	const probe = await probeDaemon(endpoint);
	if (probe.status !== "connected") {
		throw new Error(`expected connection, got ${probe.status}`);
	}
	return probe.connection;
}

afterEach(() => {
	for (const daemon of running.splice(0)) {
		daemon.stop("test teardown");
	}
});

// Every byte is the same and none is a newline, so a short write only means
// fewer bytes crossed this turn — the buffer still fills.
async function flood(
	socket: { write(data: string): number },
	total: number,
): Promise<void> {
	const chunk = "x".repeat(64 * 1024);
	for (let sent = 0; sent < total; ) {
		const written = socket.write(chunk);
		sent += written;
		await Bun.sleep(written > 0 ? 0 : 5);
	}
}

function lockHeldBy(endpoint: DaemonEndpoint): DaemonLock {
	return {
		pid: process.pid,
		version: endpoint.version,
		modelId: endpoint.modelId,
		socketPath: endpoint.paths.socketPath,
		startedAt: 0,
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
		await Bun.sleep(10);
	}
}

describe("EmbeddingDaemon", () => {
	test("greets with a matching hello and serves worker vectors", async () => {
		const { endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		expect(connection.hello.cortex).toBe(CORTEX_VERSION);
		expect(connection.hello.modelId).toBe(GEMMA_MODEL.modelId);
		expect(connection.hello.pid).toBe(process.pid);
		expect(await connection.embed("query", ["hello"])).toEqual([[5, 0, 1]]);
		connection.close();
	});

	test("serves multiple concurrent connections from one provider", async () => {
		const { daemon, endpoint } = makeDaemon();
		const first = await connect(endpoint);
		const second = await connect(endpoint);
		expect(daemon.clientCount).toBe(2);
		const [fromFirst, fromSecond] = await Promise.all([
			first.embed("query", ["aa"]),
			second.embed("passages", ["bbb", "c"]),
		]);
		expect(fromFirst).toEqual([[2, 0, 1]]);
		expect(fromSecond).toEqual([
			[3, 0, 0],
			[1, 1, 0],
		]);
		first.close();
		second.close();
	});

	test("worker errors come back as request errors", async () => {
		const { endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		expect(connection.embed("query", ["!error"])).rejects.toThrow("boom");
		connection.close();
	});

	test("a malformed request line is ignored, later requests still answer", async () => {
		const { endpoint } = makeDaemon();
		const raw = await Bun.connect({
			unix: endpoint.paths.socketPath,
			socket: { data: () => {} },
		});
		raw.write("this is not json\n");
		const connection = await connect(endpoint);
		expect(await connection.embed("query", ["still up"])).toEqual([[8, 0, 1]]);
		raw.end();
		connection.close();
	});

	test("a client that never terminates its line is dropped, not served", async () => {
		const { daemon, endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		const flooder = await Bun.connect({
			unix: endpoint.paths.socketPath,
			socket: { data: () => {} },
		});
		await Bun.sleep(20);
		expect(daemon.clientCount).toBe(2);
		await flood(flooder, 8 * 1024 * 1024 + 1);
		await waitFor(() => daemon.clientCount === 1);
		expect(daemon.clientCount).toBe(1);
		expect(await connection.embed("query", ["still up"])).toEqual([[8, 0, 1]]);
		connection.close();
	});

	test("probe rejects a daemon with a different version or model", async () => {
		const { endpoint } = makeDaemon({ version: "9.9.9-other" });
		expect((await probeDaemon(endpoint)).status).toBe("rejected");

		const second = makeDaemon();
		const wrongModel = { ...second.endpoint, modelId: "other-model@1" };
		expect((await probeDaemon(wrongModel)).status).toBe("rejected");
	});

	test("probe reports an unreachable socket as unreachable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, directory);
		const probe = await probeDaemon({
			paths,
			version: CORTEX_VERSION,
			modelId: GEMMA_MODEL.modelId,
		});
		expect(probe.status).toBe("unreachable");
	});

	test("probe rejects a listener that never sends a hello", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, directory);
		const silent = Bun.listen({
			unix: paths.socketPath,
			socket: { data: () => {} },
		});
		try {
			const probe = await probeDaemon(
				{ paths, version: CORTEX_VERSION, modelId: GEMMA_MODEL.modelId },
				{ helloTimeoutMs: 100 },
			);
			expect(probe.status).toBe("rejected");
		} finally {
			silent.stop(true);
		}
	});

	test("exits on idle after the last client disconnects", async () => {
		const { daemon, endpoint, socketPath } = makeDaemon({
			idleTimeoutMs: 150,
		});
		const connection = await connect(endpoint);
		expect(await connection.embed("query", ["hi"])).toEqual([[2, 0, 1]]);
		connection.close();
		expect(await daemon.closed).toBe("idle timeout");
		expect(existsSync(socketPath)).toBe(false);
	});

	test("a hung worker times out, heals, and the next request answers", async () => {
		const { endpoint } = makeDaemon({ requestTimeoutMs: 200 });
		const connection = await connect(endpoint);
		expect(connection.embed("passages", ["!hang"])).rejects.toThrow(
			"timed out after 200 ms",
		);
		expect(await connection.embed("query", ["healed"])).toEqual([[6, 0, 1]]);
		connection.close();
	});

	test("a query that overruns is not charged the worker", async () => {
		const { endpoint, provider } = makeDaemon({ requestTimeoutMs: 200 });
		const connection = await connect(endpoint);
		expect(connection.embed("query", ["!slow:600"])).rejects.toThrow(
			"timed out after 200 ms",
		);
		await Bun.sleep(100);
		expect(provider.workerRunning).toBe(true);
		connection.close();
	});

	test("a passage that overruns disposes the worker", async () => {
		const { endpoint, provider } = makeDaemon({ requestTimeoutMs: 200 });
		const connection = await connect(endpoint);
		expect(connection.embed("passages", ["!slow:600"])).rejects.toThrow(
			"timed out after 200 ms",
		);
		await Bun.sleep(100);
		expect(provider.workerRunning).toBe(false);
		connection.close();
	});

	// Without this the daemon re-downloads and re-kills once per request for as
	// long as sessions keep asking, and the model never lands.
	test("a model still being fetched outlives the inference deadline", async () => {
		const { endpoint } = makeDaemon({
			requestTimeoutMs: 200,
			modelResident: false,
		});
		const connection = await connect(endpoint);
		expect(await connection.embed("passages", ["!slow:400"])).toEqual([
			[9, 0, 0],
		]);
		connection.close();
	});

	test("a slow session does not spend another session's deadline", async () => {
		const { endpoint } = makeDaemon({ requestTimeoutMs: 300 });
		const first = await connect(endpoint);
		const second = await connect(endpoint);
		const slow = [1, 2, 3, 4, 5].map(() =>
			first.embed("passages", ["!slow:100"]),
		);
		const queued = second.embed("query", ["queued"]);

		expect(await queued).toEqual([[6, 0, 1]]);
		expect(await Promise.all(slow)).toHaveLength(5);
		first.close();
		second.close();
	});

	test("killing a hung worker spares the requests queued behind it", async () => {
		const { endpoint } = makeDaemon({ requestTimeoutMs: 200 });
		const first = await connect(endpoint);
		const second = await connect(endpoint);
		const hung = first.embed("passages", ["!hang"]);
		const queued = second.embed("query", ["queued"]);

		expect(hung).rejects.toThrow("timed out after 200 ms");
		expect(await queued).toEqual([[6, 0, 1]]);
		first.close();
		second.close();
	});

	// H16: without a cap the lane grows with every retry of a request whose
	// caller has already given up, and a genuinely new query waits behind all
	// of them.
	test("refuses admission beyond the lane depth with busy", async () => {
		const { endpoint } = makeDaemon({ laneDepth: 2 });
		const connection = await connect(endpoint);
		const admitted = [
			connection.embed("passages", ["!slow:300"]),
			connection.embed("passages", ["!slow:300"]),
		];
		const refused = connection.embed("query", ["over the cap"]);

		expect(refused).rejects.toThrow(DAEMON_BUSY);
		expect(await Promise.all(admitted)).toHaveLength(2);
		expect(await connection.embed("query", ["after"])).toEqual([[5, 0, 1]]);
		connection.close();
	});

	// H16: the lane starts a unit only when it reaches the head, so a session
	// that dropped is discovered before the worker spends an inference on it.
	// The abandoned request hangs the worker forever if it is ever sent, so a
	// third request answering at all is the proof that it was not.
	test("a dropped client's queued work never reaches the worker", async () => {
		const { daemon, endpoint } = makeDaemon({ requestTimeoutMs: 60_000 });
		const leaving = await connect(endpoint);
		const staying = await connect(endpoint);
		const blocking = staying.embed("passages", ["!slow:500"]);
		await Bun.sleep(50);
		const abandoned = leaving.embed("query", ["!hang"]);

		leaving.close();
		expect(abandoned).rejects.toThrow();
		await waitFor(() => daemon.clientCount === 1);
		expect(daemon.clientCount).toBe(1);
		await blocking;
		expect(await staying.embed("query", ["after"])).toEqual([[5, 0, 1]]);
		staying.close();
	});

	// M23: Bun's write takes fewer bytes than it is given once its buffer fills,
	// and a pending tail sliced by characters instead of bytes cuts a multi-byte
	// one in half — the daemon then reads a request it cannot decode.
	test("a request too large for one write survives with its accents", async () => {
		const { endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		const long = "café".repeat(400_000);
		expect(await connection.embed("passages", [long])).toEqual([
			[long.length, 0, 0],
		]);
		connection.close();
	});

	// H17: this is the second opinion on a lock whose pid may have been reused —
	// a daemon listens before it ever writes its lock, so a live one answers.
	test("a listening daemon is visible to the lock's socket probe", async () => {
		const { daemon, endpoint } = makeDaemon();
		const probe = listenerProbe(endpoint.paths, lockHeldBy(endpoint));
		expect(await probe()).toBe(true);
		await waitFor(() => daemon.clientCount === 0);

		daemon.stop("gone");
		expect(await probe()).toBe(false);
	});

	// Ownership is a connectivity question: an incompatible daemon still proves
	// the pid in the lock file belongs to a real one.
	test("a daemon of another version still counts as listening", async () => {
		const { endpoint } = makeDaemon({ version: "9.9.9-other" });
		const probe = listenerProbe(endpoint.paths, lockHeldBy(endpoint));
		expect(await probe()).toBe(true);
	});

	// M23: a response too large for one write leaves a tail the daemon must
	// resend when the socket drains, or the client reads a truncated line.
	test("a response too large for one write reaches the client whole", async () => {
		const { endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		const texts = Array.from({ length: 250_000 }, () => "café");
		const vectors = await connection.embed("passages", texts);

		expect(vectors).toHaveLength(texts.length);
		expect(vectors[texts.length - 1]).toEqual([4, texts.length - 1, 0]);
		connection.close();
	}, 15_000);

	// L9: the socket is world-permissioned for the window between listen and its
	// chmod, so a daemon directory that already existed with looser bits is what
	// actually lets another user in.
	test("a pre-existing daemon directory is narrowed to its owner", () => {
		const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
		chmodSync(directory, 0o755);
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, directory);
		const daemon = new EmbeddingDaemon({
			socketPath: paths.socketPath,
			version: CORTEX_VERSION,
			provider: new GemmaProvider({ workerPath: FAKE_WORKER }),
			idleTimeoutMs: 60_000,
		});
		daemon.start();
		running.push(daemon);

		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(paths.socketPath).mode & 0o777).toBe(0o600);
	});

	// M26: nobody awaits the promise respond returns, so a rejection escaping it
	// would land as an unhandled rejection in a process shared by every session.
	// Every failure mode is driven through it at once; the daemon keeps serving.
	test("no failure mode escapes respond as a rejection", async () => {
		const rejections: unknown[] = [];
		const record = (error: unknown) => rejections.push(error);
		process.on("unhandledRejection", record);
		const { endpoint } = makeDaemon({ requestTimeoutMs: 200, laneDepth: 2 });
		const connection = await connect(endpoint);
		const raw = await Bun.connect({
			unix: endpoint.paths.socketPath,
			socket: { data: () => {} },
		});
		try {
			raw.write("not json at all\n");
			raw.write(`${JSON.stringify({ id: "not a number" })}\n`);
			const failures = [
				connection.embed("query", ["!error"]),
				connection.embed("query", ["!hang"]),
				connection.embed("query", ["over the cap"]),
			];
			await Promise.allSettled(failures);
			await Bun.sleep(50);

			expect(rejections).toEqual([]);
			expect(await connection.embed("query", ["still up"])).toEqual([
				[8, 0, 1],
			]);
		} finally {
			process.off("unhandledRejection", record);
			raw.end();
			connection.close();
		}
	});

	test("stop severs connected clients", async () => {
		const { daemon, endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		daemon.stop("test stop");
		await Bun.sleep(50);
		expect(connection.alive).toBe(false);
	});
});
