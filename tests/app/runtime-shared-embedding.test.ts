import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntimeAt } from "@/app/runtime";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { SharedEmbeddingProvider } from "@/embedding/shared-provider";

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
});
