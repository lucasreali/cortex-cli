import { describe, expect, test } from "bun:test";
import { MarkedBlock } from "@/install/marked-block";

const BEGIN = "<!-- cortex:begin -->";
const END = "<!-- cortex:end -->";
const MARKED = new MarkedBlock(BEGIN, END);
const BODY = "cortex instructions";
const BLOCK = `${BEGIN}\n${BODY}\n${END}`;

const HASH = new MarkedBlock("# cortex-hook-start", "# cortex-hook-end");

describe("MarkedBlock.fence", () => {
	test("wraps the body between the markers", () => {
		expect(MARKED.fence(BODY)).toBe(BLOCK);
	});
});

describe("MarkedBlock.upsert", () => {
	test("a missing file is created with the block", () => {
		expect(MARKED.upsert(null, BODY)).toEqual({
			content: `${BLOCK}\n`,
			action: "created",
		});
	});

	test("an empty file is treated as created", () => {
		expect(MARKED.upsert("   \n", BODY)).toEqual({
			content: `${BLOCK}\n`,
			action: "created",
		});
	});

	test("appends after existing content with a separating blank line", () => {
		expect(MARKED.upsert("# My project\n\nNotes.\n", BODY)).toEqual({
			content: `# My project\n\nNotes.\n\n${BLOCK}\n`,
			action: "appended",
		});
	});

	test("normalizes a missing trailing newline before appending", () => {
		expect(MARKED.upsert("# My project", BODY)).toEqual({
			content: `# My project\n\n${BLOCK}\n`,
			action: "appended",
		});
	});

	test("replaces a stale block in place, keeping surrounding text", () => {
		const stale = `${BEGIN}\nold text\n${END}`;
		const existing = `# Before\n\n${stale}\n\n# After\n`;
		expect(MARKED.upsert(existing, BODY)).toEqual({
			content: `# Before\n\n${BLOCK}\n\n# After\n`,
			action: "updated",
		});
	});

	test("an up-to-date block is unchanged", () => {
		const existing = `# Before\n\n${BLOCK}\n`;
		expect(MARKED.upsert(existing, BODY)).toEqual({
			content: existing,
			action: "unchanged",
		});
	});

	test("a begin marker without an end refuses to touch the file", () => {
		const existing = `# Doc\n${BEGIN}\nhalf a block\n`;
		expect(MARKED.upsert(existing, BODY)).toEqual({
			action: "skipped-malformed",
		});
	});
});

describe("MarkedBlock.remove", () => {
	test("a missing file has nothing to remove", () => {
		expect(MARKED.remove(null)).toEqual({ action: "absent" });
	});

	test("a file without the markers has nothing to remove", () => {
		expect(MARKED.remove("# My project\n")).toEqual({ action: "absent" });
	});

	test("a begin marker without an end refuses to touch the file", () => {
		expect(MARKED.remove(`# Doc\n${BEGIN}\nhalf\n`)).toEqual({
			action: "skipped-malformed",
		});
	});

	test("a file holding only the block is left empty", () => {
		expect(MARKED.remove(`${BLOCK}\n`)).toEqual({
			content: "",
			action: "removed",
			leavesRemainderEmpty: true,
		});
	});

	test("text before and after survives with one blank line between", () => {
		const existing = `# Before\n\n${BLOCK}\n\n# After\n`;
		expect(MARKED.remove(existing)).toEqual({
			content: "# Before\n\n# After\n",
			action: "removed",
			leavesRemainderEmpty: false,
		});
	});

	test("a block at the top leaves the text below it", () => {
		expect(MARKED.remove(`${BLOCK}\n\n# After\n`)).toEqual({
			content: "# After\n",
			action: "removed",
			leavesRemainderEmpty: false,
		});
	});

	test("a remainder without a trailing newline gets one", () => {
		expect(MARKED.remove(`# Before\n\n${BLOCK}`)).toEqual({
			content: "# Before\n",
			action: "removed",
			leavesRemainderEmpty: false,
		});
	});

	test("CRLF neighbours are preserved byte for byte", () => {
		const existing = `line one\r\nline two\r\n\n${BLOCK}\n`;
		const result = MARKED.remove(existing);
		expect(result).toMatchObject({ content: "line one\r\nline two\n" });
	});

	test("blocks of another marker pair are left alone", () => {
		const hookBlock = HASH.fence("shell");
		const existing = `${hookBlock}\n\n${BLOCK}\n`;
		expect(MARKED.remove(existing)).toEqual({
			content: `${hookBlock}\n`,
			action: "removed",
			leavesRemainderEmpty: false,
		});
	});
});

describe("upsert then remove", () => {
	const originals = [
		"",
		"#!/bin/sh\n",
		"#!/bin/sh\necho mine\n",
		"# My project\n\nNotes.\n",
	];

	for (const original of originals) {
		test(`round-trips ${JSON.stringify(original)}`, () => {
			for (const block of [MARKED, HASH]) {
				const added = block.upsert(original, BODY);
				if (!("content" in added)) throw new Error("expected a write");
				const removed = block.remove(added.content);
				expect(removed).toMatchObject({ content: original });
			}
		});
	}
});
