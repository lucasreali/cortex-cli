import { describe, expect, test } from "bun:test";
import { planGitignore } from "@/install/gitignore";

const RULES = ["/.cortex/*", "!/.cortex/config", "!/.cortex/decisions/"];

function appended(current: string): string {
	const plan = planGitignore(current, RULES);
	if (plan.action !== "append") throw new Error(`planned ${plan.action}`);
	return plan.content;
}

describe("planGitignore", () => {
	test("writes the whole set into an empty file", () => {
		expect(appended("")).toBe(`${RULES.join("\n")}\n`);
	});

	test("terminates the last line before appending", () => {
		expect(appended("node_modules")).toBe(
			`node_modules\n${RULES.join("\n")}\n`,
		);
	});

	test("a file that already carries every rule is satisfied", () => {
		expect(planGitignore(`${RULES.join("\n")}\n`, RULES)).toEqual({
			action: "satisfied",
		});
	});

	test("indentation around a rule still counts as present", () => {
		expect(
			planGitignore(RULES.map((rule) => `  ${rule}  `).join("\n"), RULES),
		).toEqual({ action: "satisfied" });
	});

	test("no rules at all is satisfied", () => {
		expect(planGitignore("anything\n", [])).toEqual({ action: "satisfied" });
	});
});

// L4: the check was all-or-nothing, so a file holding two of the three rules
// had all three appended again — a duplicate at best, and at worst the
// exclusion landing below a negation that no longer overrides anything.
describe("a .gitignore that already holds part of the set", () => {
	test("gets only the missing negations, below the exclusion that needs them", () => {
		const content = appended("/.cortex/*\n");
		expect(content).toBe(
			"/.cortex/*\n!/.cortex/config\n!/.cortex/decisions/\n",
		);
	});

	test("never re-appends a rule that is already there", () => {
		const content = appended("/.cortex/*\n!/.cortex/config\n");
		expect(content.match(/!\/\.cortex\/config/g)).toHaveLength(1);
		expect(content.match(/\/\.cortex\/\*/g)).toHaveLength(1);
	});

	test("is left to its author when the exclusion would land below a negation", () => {
		expect(planGitignore("!/.cortex/config\n", RULES)).toEqual({
			action: "conflict",
			missing: ["/.cortex/*", "!/.cortex/decisions/"],
		});
	});
});
