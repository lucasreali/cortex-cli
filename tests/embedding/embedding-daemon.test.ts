import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DaemonConnection,
	type DaemonEndpoint,
	probeDaemon,
} from "@/embedding/daemon/client";
import { EmbeddingDaemon } from "@/embedding/daemon/embedding-daemon";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { CORTEX_VERSION } from "@/version";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

interface Harness {
	daemon: EmbeddingDaemon;
	endpoint: DaemonEndpoint;
	socketPath: string;
}

const running: EmbeddingDaemon[] = [];

function makeDaemon(
	overrides: {
		idleTimeoutMs?: number;
		requestTimeoutMs?: number;
		version?: string;
	} = {},
): Harness {
	const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-"));
	const paths = daemonPathsFor(GEMMA_MODEL.modelId, directory);
	const version = overrides.version ?? CORTEX_VERSION;
	const daemon = new EmbeddingDaemon({
		socketPath: paths.socketPath,
		version,
		provider: new GemmaProvider({ workerPath: FAKE_WORKER }),
		idleTimeoutMs: overrides.idleTimeoutMs ?? 60_000,
		requestTimeoutMs: overrides.requestTimeoutMs,
	});
	daemon.start();
	running.push(daemon);
	return {
		daemon,
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
		expect(connection.embed("query", ["!hang"])).rejects.toThrow(
			"timed out after 200 ms",
		);
		expect(await connection.embed("query", ["healed"])).toEqual([[6, 0, 1]]);
		connection.close();
	});

	test("stop severs connected clients", async () => {
		const { daemon, endpoint } = makeDaemon();
		const connection = await connect(endpoint);
		daemon.stop("test stop");
		await Bun.sleep(50);
		expect(connection.alive).toBe(false);
	});
});
