import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { GROUND_TRUTH } from "./ground-truth";

const storePath = new URL("../../.cortex/decisions.db", import.meta.url)
	.pathname;
const db = new Database(storePath, { readonly: true });

afterAll(() => {
	db.close();
});

describe("ground truth shape", () => {
	test("case ids are unique", () => {
		const ids = GROUND_TRUTH.map((evalCase) => evalCase.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every case has a query and at least one expected id", () => {
		for (const evalCase of GROUND_TRUTH) {
			expect(evalCase.query.length).toBeGreaterThan(0);
			expect(evalCase.expected.length).toBeGreaterThan(0);
			expect(new Set(evalCase.expected).size).toBe(evalCase.expected.length);
		}
	});
});

describe("ground truth against the dogfooded store", () => {
	test("every expected id is an active decision", () => {
		const query = db.query<{ status: string }, [string]>(
			"SELECT status FROM nodes WHERE id = ? AND kind = 'decision'",
		);
		for (const evalCase of GROUND_TRUTH) {
			for (const id of evalCase.expected) {
				const row = query.get(id);
				expect(row?.status, `${evalCase.id} expects ${id}`).toBe("active");
			}
		}
	});
});
