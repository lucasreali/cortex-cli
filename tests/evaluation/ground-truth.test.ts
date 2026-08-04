import { describe, expect, test } from "bun:test";
import { DecisionStore } from "@/decisions/decision-store";
import type { DecisionFile } from "@/domain";
import { GROUND_TRUTH } from "./ground-truth";

// The versioned files, not the derived database: this is what a fresh clone
// carries, and reading them keeps the suite honest about which artifact is
// the product.
const store = DecisionStore.at(
	new URL("../../.cortex", import.meta.url).pathname,
);

function readAll(): DecisionFile[] {
	return store.listIds().flatMap((id) => {
		const parse = store.read(id);
		if (!parse.ok) throw new Error(`${id}.md: ${parse.reason}`);
		return [parse.file];
	});
}

const decisions = readAll();
const superseded = new Set(
	decisions.flatMap((file) => (file.replaces ? [file.replaces] : [])),
);

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

describe("ground truth against the dogfooded decision files", () => {
	test("every expected id has a file on this branch", () => {
		const present = new Set(decisions.map((file) => file.id));
		for (const evalCase of GROUND_TRUTH) {
			for (const id of evalCase.expected) {
				expect(present.has(id), `${evalCase.id} expects ${id}`).toBe(true);
			}
		}
	});

	test("no expected id has been superseded", () => {
		for (const evalCase of GROUND_TRUTH) {
			for (const id of evalCase.expected) {
				expect(superseded.has(id), `${evalCase.id} expects ${id}`).toBe(false);
			}
		}
	});
});
