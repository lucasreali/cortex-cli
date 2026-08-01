import { describe, expect, test } from "bun:test";
import { KindEmbeddingProvider } from "@/embedding/kind-provider";
import type { EmbedKind } from "@/embedding/protocol";

interface Batch {
	kind: EmbedKind;
	texts: string[];
}

function recording(answer: Float32Array[] = []): {
	provider: KindEmbeddingProvider;
	batches: Batch[];
} {
	const batches: Batch[] = [];
	const provider = new KindEmbeddingProvider(
		"test-model@8",
		async (kind, texts) => {
			batches.push({ kind, texts });
			return answer;
		},
	);
	return { provider, batches };
}

describe("KindEmbeddingProvider", () => {
	test("embedQuery sends one text under the query kind", async () => {
		const { provider, batches } = recording([new Float32Array([1, 2])]);
		expect([...(await provider.embedQuery("hello"))]).toEqual([1, 2]);
		expect(batches).toEqual([{ kind: "query", texts: ["hello"] }]);
		expect(provider.modelId).toBe("test-model@8");
	});

	test("embedPassages sends every text under the passages kind", async () => {
		const { provider, batches } = recording([new Float32Array([3])]);
		await provider.embedPassages(["a", "b"]);
		expect(batches).toEqual([{ kind: "passages", texts: ["a", "b"] }]);
	});

	test("an answer with no vector is an error, not an empty query result", () => {
		const { provider } = recording([]);
		expect(provider.embedQuery("hello")).rejects.toThrow(
			"embedding worker returned no vector",
		);
	});

	// The short circuit is what keeps an empty batch from spawning a worker or
	// dialling the daemon for nothing.
	test("no texts never reaches the batch", async () => {
		const { provider, batches } = recording();
		expect(await provider.embedPassages([])).toEqual([]);
		expect(await provider.embed("query", [])).toEqual([]);
		expect(batches).toEqual([]);
	});
});
