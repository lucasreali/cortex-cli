import { describe, expect, test } from "bun:test";
import { createProvider } from "@/embedding/create-provider";
import { GEMMA_MODEL } from "@/embedding/model";

describe("createProvider", () => {
	test("builds the Gemma provider for the pinned Gemma model_id", () => {
		const provider = createProvider(GEMMA_MODEL.modelId);
		try {
			expect(provider.modelId).toBe(GEMMA_MODEL.modelId);
		} finally {
			provider.dispose();
		}
	});

	test("fails loudly for a model_id no provider implements", () => {
		expect(() => createProvider("multilingual-e5-small@384")).toThrow(
			'no embedding provider implements model_id "multilingual-e5-small@384"',
		);
	});
});
