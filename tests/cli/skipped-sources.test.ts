import { describe, expect, test } from "bun:test";
import { boundedSkippedLines } from "@/cli/skipped-sources";
import type { SkippedSource } from "@/indexer/source-walker";

function skipped(count: number): SkippedSource[] {
	return Array.from({ length: count }, (_, index) => ({
		path: `src/file-${index}.ts`,
		reason: "EACCES: permission denied",
	}));
}

function lines(count: number): string[] {
	return boundedSkippedLines(skipped(count));
}

describe("boundedSkippedLines", () => {
	test("says nothing when every file was read", () => {
		expect(lines(0)).toEqual([]);
	});

	test("names each file and why it was skipped", () => {
		expect(lines(2)).toEqual([
			"source skipped: src/file-0.ts — EACCES: permission denied",
			"source skipped: src/file-1.ts — EACCES: permission denied",
		]);
	});

	test("lists the last file that fits without an omission line", () => {
		const listed = lines(5);
		expect(listed).toHaveLength(5);
		expect(listed.at(-1)).toBe(
			"source skipped: src/file-4.ts — EACCES: permission denied",
		);
	});

	test("counts the files it omitted instead of dropping them", () => {
		const listed = lines(30);
		expect(listed).toHaveLength(6);
		expect(listed.at(-1)).toBe("... and 25 more skipped source file(s)");
	});
});
