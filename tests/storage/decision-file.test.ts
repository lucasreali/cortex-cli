import { describe, expect, test } from "bun:test";
import type { Decision, DecisionRecord } from "@/domain";
import {
	decisionFileName,
	parseDecisionFile,
	serializeDecisionFile,
} from "@/storage/decision-file";

const DECISION_ID = "019f86ed-b7fb-7000-ba43-73cff203fffe";
const OLDER_ID = "019f86dc-9878-7000-8907-d39b91633fc4";

function decision(overrides: Partial<Decision> = {}): Decision {
	return {
		id: DECISION_ID,
		title: 'storage: adotar cache derivado — o "canônico" vira texto',
		body: "Primeira linha.\n\nSegunda linha com --- no meio.\n",
		keywords: ["cache", "derived", "texto", "canonical", "storage"],
		module: "storage",
		status: "active",
		commitSha: "0748155",
		commitDirty: true,
		provenance: "agent",
		props: null,
		createdAt: "2026-07-22T15:04:05.123Z",
		anchors: [
			{ filePath: "src/storage/connection.ts", symbol: "" },
			{ filePath: "src/app/runtime.ts", symbol: "buildRuntime" },
		],
		...overrides,
	};
}

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		decision: decision(),
		dependsOn: [OLDER_ID],
		replaces: null,
		...overrides,
	};
}

describe("decision file", () => {
	test("serialize/parse round-trips every field", () => {
		const original = record({ replaces: OLDER_ID });
		const parsed = parseDecisionFile(
			serializeDecisionFile(original),
			decisionFileName(DECISION_ID),
		);
		expect(parsed.dependsOn).toEqual([OLDER_ID]);
		expect(parsed.replaces).toBe(OLDER_ID);
		expect(parsed.decision).toEqual({
			...original.decision,
			body: original.decision.body.trim(),
		});
	});

	test("optional fields are omitted from the file and default on parse", () => {
		const minimal = record({
			decision: decision({
				module: null,
				commitSha: null,
				commitDirty: false,
				anchors: [],
			}),
			dependsOn: [],
		});
		const content = serializeDecisionFile(minimal);
		expect(content).not.toContain("module:");
		expect(content).not.toContain("anchors:");
		expect(content).not.toContain("depends_on:");
		expect(content).not.toContain("commit");
		const parsed = parseDecisionFile(content, decisionFileName(DECISION_ID));
		expect(parsed.decision.module).toBeNull();
		expect(parsed.decision.commitSha).toBeNull();
		expect(parsed.decision.commitDirty).toBe(false);
		expect(parsed.decision.anchors).toEqual([]);
	});

	test("a numeric-looking commit sha survives as a string", () => {
		const parsed = parseDecisionFile(
			serializeDecisionFile(record()),
			decisionFileName(DECISION_ID),
		);
		expect(parsed.decision.commitSha).toBe("0748155");
	});

	test("rejects content without frontmatter", () => {
		expect(() => parseDecisionFile("just a body", "x.md")).toThrow(
			"missing frontmatter",
		);
	});

	test("rejects a frontmatter id that contradicts the file name", () => {
		expect(() =>
			parseDecisionFile(serializeDecisionFile(record()), `${OLDER_ID}.md`),
		).toThrow("does not match file name");
	});

	test("rejects invalid frontmatter with the file name in the error", () => {
		const broken = "---\nid: not-a-uuid\n---\nbody";
		expect(() => parseDecisionFile(broken, "broken.md")).toThrow(
			"invalid decision file broken.md",
		);
	});
});
