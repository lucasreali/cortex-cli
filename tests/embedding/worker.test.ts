import { describe, expect, test } from "bun:test";
import { GEMMA_MODEL } from "@/embedding/model";
import { embedWorkerCommand } from "@/embedding/subprocess-command";

// The audit exempts src/embedding/worker.ts from the 100% threshold as
// "subprocess covered", and for this file that was not true: cli.test.ts spawned
// it with empty stdin, so the `for await` never yielded and handleLine, embed,
// createExtractor, sliceRows and truncateAndNormalize were executed by nothing
// in `bun test`. A transformers.js upgrade selecting the native backend, or
// truncateAndNormalize ceasing to normalize — which is a silently wrong cosine
// ranking, not a crash — would both have shipped green.
//
// The NDJSON loop is driven here on every run; the model-bearing half needs the
// weights, so it runs under RUN_MODEL_TESTS=1 like the other two model tests.
const modelTest = process.env.RUN_MODEL_TESTS === "1" ? test : test.skip;
const MODEL_TIMEOUT = 900_000;

interface WorkerRun {
	code: number;
	responses: Array<{ id: number; vectors?: number[][]; error?: string }>;
	stderr: string;
}

// The real spawn, through the same command the providers use: what this proves
// about the worker is only worth as much as the way it is started.
async function runWorker(lines: string[]): Promise<WorkerRun> {
	const command = embedWorkerCommand();
	const child = Bun.spawn([command.executable, ...command.argv], {
		stdin: new TextEncoder().encode(lines.map((line) => `${line}\n`).join("")),
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return {
		code: (await child.exited) ?? 1,
		responses: stdout
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line)),
		stderr,
	};
}

function norm(vector: number[]): number {
	return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe("the embed worker's NDJSON loop", () => {
	// Answering an unknown id would settle someone else's request, and throwing
	// would take the whole worker down over one bad line from one peer.
	test("says nothing about a line it cannot decode, and keeps reading", async () => {
		const run = await runWorker([
			"",
			"not json at all",
			"{}",
			'{"id":"one","kind":"query","texts":["x"]}',
			'{"id":1,"kind":"summarize","texts":["x"]}',
			'{"id":2,"kind":"query"}',
			'{"id":3,"kind":"query","texts":"a string"}',
		]);

		expect(run.responses).toEqual([]);
		expect(run.code).toBe(0);
	}, 30_000);

	test("ends when its stdin closes", async () => {
		const run = await runWorker([]);
		expect(run.code).toBe(0);
		expect(run.responses).toEqual([]);
	}, 30_000);
});

describe("the embed worker with the real model (RUN_MODEL_TESTS=1)", () => {
	// One request, two texts: the output arrives as a single flat Float32Array
	// with its shape in `dims`, so anything wrong in sliceRows returns the right
	// number of vectors filled with the wrong halves of the batch.
	modelTest(
		"answers a batch with one unit-length row per text",
		async () => {
			const run = await runWorker([
				JSON.stringify({
					id: 7,
					kind: "passages",
					texts: [
						"optamos por JWT stateless para autenticação de usuários",
						"a receita de bolo de cenoura leva três ovos",
					],
				}),
			]);

			expect(run.code).toBe(0);
			expect(run.responses).toHaveLength(1);
			const [answer] = run.responses;
			expect(answer?.id).toBe(7);
			expect(answer?.vectors).toHaveLength(2);
			for (const vector of answer?.vectors ?? []) {
				// Matryoshka truncation to 256 and a re-normalize afterwards: a
				// vector that kept the model's full width, or lost the normalize,
				// silently changes every cosine score in the store.
				expect(vector).toHaveLength(GEMMA_MODEL.dims);
				expect(norm(vector)).toBeCloseTo(1, 3);
			}
			expect(answer?.vectors?.[0]).not.toEqual(
				answer?.vectors?.[1] as number[],
			);
		},
		MODEL_TIMEOUT,
	);

	// The prefixes are the model's own asymmetry; a query embedded as a passage
	// answers the wrong question with full confidence.
	modelTest(
		"embeds a query nearer its answer than an unrelated passage",
		async () => {
			const run = await runWorker([
				JSON.stringify({
					id: 1,
					kind: "passages",
					texts: [
						"optamos por JWT stateless para autenticação de usuários",
						"a receita de bolo de cenoura leva três ovos",
					],
				}),
				JSON.stringify({
					id: 2,
					kind: "query",
					texts: ["como autenticamos usuários?"],
				}),
			]);

			const passages = run.responses.find((one) => one.id === 1)?.vectors ?? [];
			const [query] = run.responses.find((one) => one.id === 2)?.vectors ?? [];
			const dot = (a: number[], b: number[]) =>
				a.reduce((sum, value, index) => sum + value * (b[index] as number), 0);

			expect(dot(query as number[], passages[0] as number[])).toBeGreaterThan(
				dot(query as number[], passages[1] as number[]),
			);
		},
		MODEL_TIMEOUT,
	);

	// One peer's odd request must not cost the next one its answer: a worker
	// that died here would leave every id behind it waiting out its deadline.
	modelTest(
		"an empty batch is answered like any other, and the worker keeps serving",
		async () => {
			const run = await runWorker([
				JSON.stringify({ id: 1, kind: "passages", texts: [] }),
				JSON.stringify({ id: 2, kind: "query", texts: ["olá"] }),
			]);

			expect(run.code).toBe(0);
			expect(run.responses.map((one) => one.id)).toEqual([1, 2]);
			expect(run.responses[1]?.vectors).toHaveLength(1);
		},
		MODEL_TIMEOUT,
	);
});
