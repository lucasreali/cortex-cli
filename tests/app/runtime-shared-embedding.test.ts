import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeAt } from "@/app/runtime";
import { EmbeddingDaemon } from "@/embedding/daemon/embedding-daemon";
import { daemonPathsFor } from "@/embedding/daemon/paths";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { SharedEmbeddingProvider } from "@/embedding/shared-provider";
import { CORTEX_VERSION } from "@/version";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

const originalDaemonDir = process.env.CORTEX_DAEMON_DIR;

afterEach(() => {
	if (originalDaemonDir === undefined) delete process.env.CORTEX_DAEMON_DIR;
	else process.env.CORTEX_DAEMON_DIR = originalDaemonDir;
});

function makeProjectDir(): string {
	return mkdtempSync(join(tmpdir(), "cortex-runtime-"));
}

describe("runtime embedding provider selection", () => {
	test("MCP-style runtimes opt into the shared daemon provider", async () => {
		const runtime = await buildRuntimeAt(makeProjectDir(), {
			sharedEmbedding: true,
		});
		try {
			expect(runtime.provider).toBeInstanceOf(SharedEmbeddingProvider);
		} finally {
			runtime.dispose();
		}
	});

	test("CLI runtimes keep the private direct provider", async () => {
		const runtime = await buildRuntimeAt(makeProjectDir());
		try {
			expect(runtime.provider).toBeInstanceOf(GemmaProvider);
		} finally {
			runtime.dispose();
		}
	});

	test("a decision queued on a shared runtime embeds through the daemon", async () => {
		const daemonDirectory = mkdtempSync(join(tmpdir(), "cortex-rt-daemon-"));
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, daemonDirectory);
		const daemon = new EmbeddingDaemon({
			socketPath: paths.socketPath,
			version: CORTEX_VERSION,
			provider: new GemmaProvider({ workerPath: FAKE_WORKER }),
			idleTimeoutMs: 60_000,
		});
		daemon.start();
		process.env.CORTEX_DAEMON_DIR = daemonDirectory;

		const runtime = await buildRuntimeAt(makeProjectDir(), {
			sharedEmbedding: true,
		});
		try {
			const decision = runtime.decisions.save(
				{
					title: "Runtime embeds through the shared daemon",
					body: "Queued embeddings on MCP runtimes go through the user-wide daemon.",
					keywords: ["daemon", "runtime", "embedding", "shared", "queue"],
				},
				runtime.saveContext(),
			);
			runtime.queue?.enqueue(decision.id);
			await runtime.queue?.onIdle();

			const vectors = runtime.embeddings.listActiveVectors(GEMMA_MODEL.modelId);
			expect(vectors.map((entry) => entry.nodeId)).toEqual([decision.id]);
			const provider = runtime.provider as SharedEmbeddingProvider;
			expect(provider.daemonConnected).toBe(true);
		} finally {
			runtime.dispose();
			daemon.stop("test teardown");
		}
	});
});
