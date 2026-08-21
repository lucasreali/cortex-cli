import { describe, expect, test } from "bun:test";
import { flagsIn, presentArguments, wholeNumber } from "@/cli/arguments";

describe("flagsIn", () => {
	test("is every argument when nothing terminates the flags", () => {
		expect(flagsIn(["--json", "auth"])).toEqual(["--json", "auth"]);
	});

	test("stops at the terminator, so a later flag word is a positional", () => {
		expect(flagsIn(["--exact", "--", "-h", "--json"])).toEqual(["--exact"]);
	});

	test("is empty when the terminator comes first", () => {
		expect(flagsIn(["--", "-h"])).toEqual([]);
	});
});

describe("presentArguments", () => {
	test("keeps the arguments that carry a value", () => {
		expect(presentArguments(["auth", "session"])).toEqual(["auth", "session"]);
	});

	test("drops the empty and the whitespace-only ones", () => {
		expect(presentArguments(["", "  ", "\t", "auth"])).toEqual(["auth"]);
	});
});

describe("wholeNumber", () => {
	test("reads a count spelled in digits", () => {
		expect(wholeNumber("0")).toBe(0);
		expect(wholeNumber("12")).toBe(12);
	});

	test("refuses everything Number would have accepted anyway", () => {
		for (const raw of ["1e3", "0x10", ".5", "-1", " 5", "5 ", "", "five"]) {
			expect(wholeNumber(raw)).toBeNull();
		}
	});
});
