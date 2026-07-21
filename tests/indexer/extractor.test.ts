import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureGrammar } from "@/indexer/grammar";
import { TsxExtractor } from "@/indexer/tsx-extractor";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "indexer");

let extractor: TsxExtractor;

beforeAll(async () => {
	extractor = await TsxExtractor.create(await ensureGrammar());
});

describe("TsxExtractor", () => {
	test("extracts symbols and imports from every fixture", async () => {
		const fixtures = readdirSync(FIXTURES_DIR).sort();
		expect(fixtures.length).toBeGreaterThanOrEqual(10);

		const extracted: Record<string, unknown> = {};
		for (const fixture of fixtures) {
			const source = await Bun.file(join(FIXTURES_DIR, fixture)).text();
			extracted[fixture] = extractor.extract(source);
		}
		expect(extracted).toMatchSnapshot();
	});

	test("qualifies methods with their class name", async () => {
		const source = await Bun.file(join(FIXTURES_DIR, "nested.ts")).text();
		const { symbols } = extractor.extract(source);
		const methods = symbols.filter((symbol) => symbol.kind === "method");
		expect(methods.map((method) => method.name)).toEqual([
			"TokenStore.load",
			"AuthService.constructor",
			"AuthService.validateToken",
		]);
	});

	test("dedupes repeated specifiers and ignores non-require calls", () => {
		const { imports, symbols } = extractor.extract(
			`import { a } from "./shared";
			 const b = require("./shared");
			 const c = notRequire("./other");
			 c(a, b);`,
		);
		expect(imports).toEqual(["./shared"]);
		expect(symbols).toEqual([]);
	});

	test("a type-only fixture yields no symbols and no imports", async () => {
		const source = await Bun.file(join(FIXTURES_DIR, "types-only.ts")).text();
		expect(extractor.extract(source)).toEqual({ symbols: [], imports: [] });
	});
});
