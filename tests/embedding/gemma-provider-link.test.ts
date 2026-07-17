import { afterEach, describe, expect, test } from "bun:test";
import { GemmaProvider } from "@/embedding/gemma-provider";

const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

let provider: GemmaProvider;

function makeProvider(idleTimeoutMs?: number): GemmaProvider {
	provider = new GemmaProvider({ workerPath: FAKE_WORKER, idleTimeoutMs });
	return provider;
}

afterEach(() => {
	provider?.dispose();
});

describe("GemmaProvider over the worker protocol (fake worker)", () => {
	test("embedQuery spawns lazily and returns the worker's vector", async () => {
		const gemma = makeProvider();
		expect(gemma.workerRunning).toBe(false);

		const vector = await gemma.embedQuery("hello");
		expect(gemma.workerRunning).toBe(true);
		expect(vector).toBeInstanceOf(Float32Array);
		expect([...vector]).toEqual([5, 0, 1]);
	});

	test("embedPassages maps every text and tags the passages kind", async () => {
		const gemma = makeProvider();
		const vectors = await gemma.embedPassages(["ab", "cdef"]);
		expect(vectors.map((vector) => [...vector])).toEqual([
			[2, 0, 0],
			[4, 1, 0],
		]);
	});

	test("embedPassages with no texts never spawns the worker", async () => {
		const gemma = makeProvider();
		expect(await gemma.embedPassages([])).toEqual([]);
		expect(gemma.workerRunning).toBe(false);
	});

	test("concurrent requests share one worker", async () => {
		const gemma = makeProvider();
		const [first, second] = await Promise.all([
			gemma.embedQuery("aa"),
			gemma.embedQuery("bbb"),
		]);
		expect([...(first as Float32Array)]).toEqual([2, 0, 1]);
		expect([...(second as Float32Array)]).toEqual([3, 0, 1]);
	});

	test("an error response rejects that request", async () => {
		const gemma = makeProvider();
		expect(gemma.embedQuery("!error")).rejects.toThrow("boom");
	});

	test("an empty vectors response rejects embedQuery", async () => {
		const gemma = makeProvider();
		expect(gemma.embedQuery("!empty")).rejects.toThrow(
			"embedding worker returned no vector",
		);
	});

	test("blank lines and unknown response ids are ignored", async () => {
		const gemma = makeProvider();
		const vector = await gemma.embedQuery("!noise");
		expect([...vector]).toEqual([6, 0, 1]);
	});

	test("a worker that dies mid-request rejects and respawns on demand", async () => {
		const gemma = makeProvider();
		expect(gemma.embedQuery("!exit")).rejects.toThrow(
			"embedding worker exited",
		);
		const vector = await gemma.embedQuery("back");
		expect([...vector]).toEqual([4, 0, 1]);
		expect(gemma.workerRunning).toBe(true);
	});

	test("idle-kill stops the worker and the next call respawns it", async () => {
		const gemma = makeProvider(150);
		await gemma.embedQuery("first");
		expect(gemma.workerRunning).toBe(true);

		await Bun.sleep(400);
		expect(gemma.workerRunning).toBe(false);

		expect([...(await gemma.embedQuery("again"))]).toEqual([5, 0, 1]);
	});

	test("dispose is safe before any spawn and kills a live worker", async () => {
		const untouched = makeProvider();
		untouched.dispose();
		expect(untouched.workerRunning).toBe(false);

		const gemma = makeProvider();
		await gemma.embedQuery("alive");
		gemma.dispose();
		expect(gemma.workerRunning).toBe(false);
	});
});
