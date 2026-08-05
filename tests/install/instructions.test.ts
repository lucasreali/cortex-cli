import { describe, expect, test } from "bun:test";
import {
	CORTEX_BLOCK_BEGIN,
	CORTEX_BLOCK_END,
	CORTEX_INSTRUCTIONS_BLOCK,
	upsertMarkedBlock,
} from "@/install/instructions";

const BLOCK = CORTEX_INSTRUCTIONS_BLOCK;

describe("the instructions template", () => {
	test("is fenced by the markers and names the six tools", () => {
		expect(BLOCK.startsWith(CORTEX_BLOCK_BEGIN)).toBe(true);
		expect(BLOCK.endsWith(CORTEX_BLOCK_END)).toBe(true);
		for (const tool of [
			"save_decision",
			"save_session_summary",
			"get_context",
			"get_impact",
			"search",
			"search_all_projects",
		]) {
			expect(BLOCK).toContain(tool);
		}
	});
});

describe("upsertMarkedBlock", () => {
	test("a missing file is created with the block", () => {
		expect(upsertMarkedBlock(null, BLOCK)).toEqual({
			content: `${BLOCK}\n`,
			action: "created",
		});
	});

	test("an empty file is treated as created", () => {
		expect(upsertMarkedBlock("   \n", BLOCK)).toEqual({
			content: `${BLOCK}\n`,
			action: "created",
		});
	});

	test("appends after existing content with a separating blank line", () => {
		const result = upsertMarkedBlock("# My project\n\nNotes.\n", BLOCK);
		expect(result).toEqual({
			content: `# My project\n\nNotes.\n\n${BLOCK}\n`,
			action: "appended",
		});
	});

	test("normalizes a missing trailing newline before appending", () => {
		const result = upsertMarkedBlock("# My project", BLOCK);
		expect(result).toEqual({
			content: `# My project\n\n${BLOCK}\n`,
			action: "appended",
		});
	});

	test("replaces a stale block in place, keeping surrounding text", () => {
		const stale = `${CORTEX_BLOCK_BEGIN}\nold text\n${CORTEX_BLOCK_END}`;
		const existing = `# Before\n\n${stale}\n\n# After\n`;
		const result = upsertMarkedBlock(existing, BLOCK);
		expect(result).toEqual({
			content: `# Before\n\n${BLOCK}\n\n# After\n`,
			action: "updated",
		});
	});

	test("an up-to-date block is unchanged", () => {
		const existing = `# Before\n\n${BLOCK}\n`;
		const result = upsertMarkedBlock(existing, BLOCK);
		expect(result).toEqual({ content: existing, action: "unchanged" });
	});

	test("a begin marker without an end refuses to touch the file", () => {
		const existing = `# Doc\n${CORTEX_BLOCK_BEGIN}\nhalf a block\n`;
		expect(upsertMarkedBlock(existing, BLOCK)).toEqual({
			action: "skipped-malformed",
		});
	});
});
