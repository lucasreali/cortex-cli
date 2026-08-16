import { describe, expect, test } from "bun:test";
import { boundedMalformedLines } from "@/cli/malformed-files";
import type { MalformedDecisionFile } from "@/decisions/reconcile";

function malformed(count: number): MalformedDecisionFile[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `file-${index}.md`,
		reason: "no frontmatter",
	}));
}

function lines(count: number): string[] {
	return boundedMalformedLines(
		malformed(count),
		(entry) => `${entry.name}: ${entry.reason}`,
	);
}

describe("boundedMalformedLines", () => {
	test("says nothing when every file parsed", () => {
		expect(lines(0)).toEqual([]);
	});

	test("lists every file while they fit", () => {
		expect(lines(3)).toEqual([
			"file-0.md: no frontmatter",
			"file-1.md: no frontmatter",
			"file-2.md: no frontmatter",
		]);
	});

	test("lists the last file that fits without an omission line", () => {
		const listed = lines(5);
		expect(listed).toHaveLength(5);
		expect(listed.at(-1)).toBe("file-4.md: no frontmatter");
	});

	test("counts the files it omitted instead of dropping them", () => {
		const listed = lines(200);
		expect(listed).toHaveLength(6);
		expect(listed.slice(0, 5)).toEqual(
			malformed(5).map((entry) => `${entry.name}: ${entry.reason}`),
		);
		expect(listed.at(-1)).toBe(
			"... and 195 more unreadable decision file(s) — run: cortex sync --json for the full list",
		);
	});
});
