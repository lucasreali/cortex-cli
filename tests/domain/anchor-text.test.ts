import { describe, expect, test } from "bun:test";
import {
	formatAnchorText,
	normalizeAnchorPath,
	parseAnchorText,
} from "@/domain";

describe("parseAnchorText", () => {
	test("round-trips a file anchor and a symbol anchor", () => {
		for (const anchor of [
			{ filePath: "src/a.ts", symbol: "" },
			{ filePath: "src/a.ts", symbol: "Auth.login" },
		]) {
			expect(parseAnchorText(formatAnchorText(anchor))).toEqual(anchor);
		}
	});

	test("keeps a '#' that belongs to the path", () => {
		expect(parseAnchorText("docs/c#/intro.md#Intro")).toEqual({
			filePath: "docs/c#/intro.md",
			symbol: "Intro",
		});
	});

	test("reads a legacy private member as part of the symbol", () => {
		expect(parseAnchorText("src/x.ts#Foo.#secret")).toEqual({
			filePath: "src/x.ts",
			symbol: "Foo.#secret",
		});
	});
});

describe("normalizeAnchorPath", () => {
	test("spells a path the way the code index does", () => {
		expect(normalizeAnchorPath("src\\auth\\jwt.ts")).toBe("src/auth/jwt.ts");
		expect(normalizeAnchorPath("./src//auth/./jwt.ts")).toBe("src/auth/jwt.ts");
		expect(normalizeAnchorPath("src/auth/")).toBe("src/auth");
	});
});
