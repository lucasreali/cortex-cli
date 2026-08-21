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
	const listing = store.list();
	if (!listing.ok) throw new Error(`.cortex/decisions: ${listing.reason}`);
	return listing.ids.flatMap((id) => {
		const parse = store.read(id);
		if (!parse.ok) throw new Error(`${id}.md: ${parse.reason}`);
		return [parse.file];
	});
}

const decisions = readAll();
// Status is derived from both links: `replaces` retires a decision in favour of
// a successor, `archives` retires one that has none. A case expecting either is
// asking the eval to rank something the search deliberately no longer returns —
// which reads as a recall regression and is a stale fixture.
const retired = new Set(
	decisions.flatMap((file) => [file.replaces, file.archives]).filter(Boolean),
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

	test("no expected id has been replaced or archived", () => {
		for (const evalCase of GROUND_TRUTH) {
			for (const id of evalCase.expected) {
				expect(retired.has(id), `${evalCase.id} expects ${id}`).toBe(false);
			}
		}
	});

	// The listing is what a fresh clone carries, so a case naming a decision no
	// file declares is a case the eval can never satisfy.
	test("every retired decision names one that exists", () => {
		const present = new Set(decisions.map((file) => file.id));
		for (const id of retired) {
			expect(present.has(id as string), `${id} is retired by a file`).toBe(
				true,
			);
		}
	});
});
