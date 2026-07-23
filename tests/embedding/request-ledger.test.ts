import { describe, expect, test } from "bun:test";
import { VectorRequestLedger } from "@/embedding/request-ledger";

describe("VectorRequestLedger", () => {
	test("open assigns sequential ids and settle resolves by id", async () => {
		const ledger = new VectorRequestLedger();
		const first = ledger.open("query", ["a"]);
		const second = ledger.open("passages", ["b", "c"]);
		expect(first.request.id).toBe(1);
		expect(second.request).toEqual({
			id: 2,
			kind: "passages",
			texts: ["b", "c"],
		});

		ledger.settle(JSON.stringify({ id: 2, vectors: [[2], [3]] }));
		ledger.settle(JSON.stringify({ id: 1, vectors: [[1]] }));
		expect(await first.vectors).toEqual([[1]]);
		expect(await second.vectors).toEqual([[2], [3]]);
	});

	test("error responses reject that request only", async () => {
		const ledger = new VectorRequestLedger();
		const failing = ledger.open("query", ["a"]);
		const fine = ledger.open("query", ["b"]);
		ledger.settle(JSON.stringify({ id: 1, error: "boom" }));
		ledger.settle(JSON.stringify({ id: 2, vectors: [[9]] }));
		expect(failing.vectors).rejects.toThrow("boom");
		expect(await fine.vectors).toEqual([[9]]);
	});

	test("garbage and unknown ids are ignored", async () => {
		const ledger = new VectorRequestLedger();
		const opened = ledger.open("query", ["a"]);
		ledger.settle("not json at all");
		ledger.settle(JSON.stringify({ id: 999, vectors: [] }));
		ledger.settle(JSON.stringify({ id: 1, vectors: [[7]] }));
		expect(await opened.vectors).toEqual([[7]]);
	});

	test("rejectAll rejects every pending request once", async () => {
		const ledger = new VectorRequestLedger();
		const first = ledger.open("query", ["a"]);
		const second = ledger.open("query", ["b"]);
		ledger.rejectAll(new Error("link down"));
		expect(first.vectors).rejects.toThrow("link down");
		expect(second.vectors).rejects.toThrow("link down");

		ledger.settle(JSON.stringify({ id: 1, vectors: [[1]] }));
		const fresh = ledger.open("query", ["c"]);
		ledger.settle(JSON.stringify({ id: 3, vectors: [[3]] }));
		expect(await fresh.vectors).toEqual([[3]]);
	});
});
