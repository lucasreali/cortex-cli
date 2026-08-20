import { describe, expect, test } from "bun:test";
import { SymbolTable } from "@/storage/symbol-table";

function table(
	rows: Array<[name: string, filePath: string, line: number]>,
): SymbolTable {
	return new SymbolTable(
		rows.map(([name, file_path, line]) => ({
			name,
			file_path,
			line,
			kind: "function",
		})),
	);
}

describe("SymbolTable", () => {
	test("answers by the normalized key, not the stored spelling", () => {
		const symbols = table([["AuthService.validateToken", "src/auth.ts", 10]]);

		expect(symbols.locationsOf("authservice . VALIDATETOKEN")).toEqual([
			{ filePath: "src/auth.ts", kind: "function", line: 10 },
		]);
	});

	test("keeps every location a name has, in the order they were read", () => {
		const symbols = table([
			["login", "src/a.ts", 3],
			["login", "src/b.ts", 9],
		]);

		expect(symbols.locationsOf("login").map((one) => one.filePath)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	test("a name nothing declares has no locations", () => {
		expect(table([["login", "src/a.ts", 3]]).locationsOf("logout")).toEqual([]);
	});
});
