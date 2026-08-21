import { describe, expect, test } from "bun:test";
import {
	CORTEX_BLOCK_BEGIN,
	CORTEX_BLOCK_END,
	CORTEX_INSTRUCTIONS_BLOCK,
	CORTEX_INSTRUCTIONS_BODY,
	INSTRUCTIONS_BLOCK,
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

	test("the bound block writes the same text init would", () => {
		expect(INSTRUCTIONS_BLOCK.upsert(null, CORTEX_INSTRUCTIONS_BODY)).toEqual({
			content: `${BLOCK}\n`,
			action: "created",
		});
	});
});
