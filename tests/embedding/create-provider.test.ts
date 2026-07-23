import { afterEach, describe, expect, test } from "bun:test";
import {
	createDirectProvider,
	createProvider,
} from "@/embedding/create-provider";
import { GemmaProvider } from "@/embedding/gemma-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { SharedEmbeddingProvider } from "@/embedding/shared-provider";

const originalNoDaemon = process.env.CORTEX_NO_DAEMON;

afterEach(() => {
	if (originalNoDaemon === undefined) delete process.env.CORTEX_NO_DAEMON;
	else process.env.CORTEX_NO_DAEMON = originalNoDaemon;
});

describe("createProvider", () => {
	test("builds the direct Gemma provider for the pinned Gemma model_id", () => {
		const provider = createProvider(GEMMA_MODEL.modelId);
		try {
			expect(provider.modelId).toBe(GEMMA_MODEL.modelId);
			expect(provider).toBeInstanceOf(GemmaProvider);
		} finally {
			provider.dispose?.();
		}
	});

	test("shared: true wraps the Gemma provider in the daemon client", () => {
		delete process.env.CORTEX_NO_DAEMON;
		const provider = createProvider(GEMMA_MODEL.modelId, { shared: true });
		try {
			expect(provider).toBeInstanceOf(SharedEmbeddingProvider);
			expect(provider.modelId).toBe(GEMMA_MODEL.modelId);
		} finally {
			provider.dispose?.();
		}
	});

	test("CORTEX_NO_DAEMON=1 forces the direct provider even when shared", () => {
		process.env.CORTEX_NO_DAEMON = "1";
		const provider = createProvider(GEMMA_MODEL.modelId, { shared: true });
		try {
			expect(provider).toBeInstanceOf(GemmaProvider);
		} finally {
			provider.dispose?.();
		}
	});

	test("fails loudly for a model_id no provider implements", () => {
		expect(() => createProvider("multilingual-e5-small@384")).toThrow(
			'no embedding provider implements model_id "multilingual-e5-small@384"',
		);
		expect(() => createDirectProvider("multilingual-e5-small@384")).toThrow(
			'no embedding provider implements model_id "multilingual-e5-small@384"',
		);
	});
});
