import { describe, expect, test } from "bun:test";
import type { WorkerRequest } from "@/embedding/protocol";
import { VectorRequestLedger } from "@/embedding/request-ledger";

function collectInto(sent: WorkerRequest[]): (request: WorkerRequest) => void {
	return (request) => {
		sent.push(request);
	};
}

const ignore = () => {};

describe("VectorRequestLedger", () => {
	test("dispatch assigns sequential ids and settle resolves by id", async () => {
		const ledger = new VectorRequestLedger();
		const sent: WorkerRequest[] = [];
		const first = ledger.dispatch("query", ["a"], collectInto(sent));
		const second = ledger.dispatch("passages", ["b", "c"], collectInto(sent));
		expect(sent[0]?.id).toBe(1);
		expect(sent[1]).toEqual({ id: 2, kind: "passages", texts: ["b", "c"] });

		ledger.settle(JSON.stringify({ id: 2, vectors: [[2], [3]] }));
		ledger.settle(JSON.stringify({ id: 1, vectors: [[1]] }));
		expect(await first).toEqual([[1]]);
		expect(await second).toEqual([[2], [3]]);
	});

	test("error responses reject that request only", async () => {
		const ledger = new VectorRequestLedger();
		const failing = ledger.dispatch("query", ["a"], ignore);
		const fine = ledger.dispatch("query", ["b"], ignore);
		ledger.settle(JSON.stringify({ id: 1, error: "boom" }));
		ledger.settle(JSON.stringify({ id: 2, vectors: [[9]] }));
		expect(failing).rejects.toThrow("boom");
		expect(await fine).toEqual([[9]]);
	});

	test("garbage and unknown ids are ignored", async () => {
		const ledger = new VectorRequestLedger();
		const dispatched = ledger.dispatch("query", ["a"], ignore);
		ledger.settle("not json at all");
		ledger.settle(JSON.stringify({ id: 999, vectors: [] }));
		ledger.settle(JSON.stringify({ id: 1, vectors: [[7]] }));
		expect(await dispatched).toEqual([[7]]);
	});

	test("rejectAll rejects every pending request once", async () => {
		const ledger = new VectorRequestLedger();
		const first = ledger.dispatch("query", ["a"], ignore);
		const second = ledger.dispatch("query", ["b"], ignore);
		ledger.rejectAll(new Error("link down"));
		expect(first).rejects.toThrow("link down");
		expect(second).rejects.toThrow("link down");
	});

	// M24: the peer can die between a caller's liveness check and its write,
	// and a request recorded after that would never settle.
	test("a request dispatched after rejectAll settles instead of hanging", async () => {
		const ledger = new VectorRequestLedger();
		const sent: WorkerRequest[] = [];
		ledger.rejectAll(new Error("link down"));
		const late = ledger.dispatch("query", ["c"], collectInto(sent));

		expect(late).rejects.toThrow("link down");
		expect(sent).toEqual([]);
	});

	test("a send that throws rejects only its own request", async () => {
		const ledger = new VectorRequestLedger();
		const thrown = ledger.dispatch("query", ["a"], () => {
			throw new Error("socket gone");
		});
		const fine = ledger.dispatch("query", ["b"], ignore);

		expect(thrown).rejects.toThrow("socket gone");
		ledger.settle(JSON.stringify({ id: 2, vectors: [[4]] }));
		expect(await fine).toEqual([[4]]);
	});
});
