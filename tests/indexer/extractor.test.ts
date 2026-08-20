import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { ensureGrammars } from "@/indexer/grammar";
import { TsxExtractor } from "@/indexer/tsx-extractor";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures", "indexer");

const LANG_BY_EXTENSION: Record<string, string> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "jsx",
};

let extractor: TsxExtractor;

function langOf(fixture: string): string {
	return LANG_BY_EXTENSION[extname(fixture)] ?? "tsx";
}

function names(source: string, lang = "ts"): string[] {
	return extractor.extract(source, lang).symbols.map((symbol) => symbol.name);
}

beforeAll(async () => {
	extractor = await TsxExtractor.create(await ensureGrammars());
});

describe("TsxExtractor", () => {
	test("extracts symbols and imports from every fixture", async () => {
		const fixtures = readdirSync(FIXTURES_DIR).sort();
		expect(fixtures.length).toBeGreaterThanOrEqual(10);

		const extracted: Record<string, unknown> = {};
		for (const fixture of fixtures) {
			const source = await Bun.file(join(FIXTURES_DIR, fixture)).text();
			extracted[fixture] = extractor.extract(source, langOf(fixture));
		}
		expect(extracted).toMatchSnapshot();
	});

	test("qualifies methods with their class name", async () => {
		const source = await Bun.file(join(FIXTURES_DIR, "nested.ts")).text();
		const { symbols } = extractor.extract(source, "ts");
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
			"ts",
		);
		expect(imports).toEqual(["./shared"]);
		expect(symbols).toEqual([]);
	});

	// Before H10 this fixture yielded nothing at all, which is what made an
	// anchor on an interface grade `unresolved`.
	test("a type-only fixture yields its declarations and no imports", async () => {
		const source = await Bun.file(join(FIXTURES_DIR, "types-only.ts")).text();
		const extracted = extractor.extract(source, "ts");
		expect(extracted.imports).toEqual([]);
		expect(extracted.hasError).toBe(false);
		expect(extracted.symbols).toEqual([
			{ name: "User", kind: "interface", line: 1 },
			{ name: "UserId", kind: "type", line: 6 },
		]);
	});

	// web-tree-sitter frees a tree only through delete() and registers no
	// FinalizationRegistry, so a leaked tree is unreachable to the GC: this
	// same loop retained ~3.5 MB per parse before extract() deleted its tree,
	// which is what made `cortex index` peak at 935 MB on 18 MB of source.
	test("parses do not retain the WASM heap", () => {
		const source = Array.from(
			{ length: 800 },
			(_, index) =>
				`export function f${index}(a: number) { return a + ${index}; }`,
		).join("\n");
		extractor.extract(source, "ts");
		Bun.gc(true);
		const before = process.memoryUsage().external;

		for (let round = 0; round < 100; round++) extractor.extract(source, "ts");

		Bun.gc(true);
		const retained = process.memoryUsage().external - before;
		expect(retained).toBeLessThan(50 * 1024 * 1024);
	}, 30_000);
});

// Every row here was an empty symbol list before: `save_decision` told the
// model the symbol did not exist, and anchor grading called it `unresolved` —
// asserting the code had changed when only the extractor was blind.
describe("TsxExtractor declaration coverage", () => {
	test.each([
		["export interface UserRepo { find(): void }", "UserRepo", "interface"],
		["export type UserId = string;", "UserId", "type"],
		["export enum Color { Red }", "Color", "enum"],
		["export function* gen() {}", "gen", "function"],
		["declare function ambientFn(): void;", "ambientFn", "function"],
		["export const doIt = function () {};", "doIt", "function"],
		["export const Card = React.memo(() => null);", "Card", "variable"],
		["export var legacy = 1;", "legacy", "variable"],
		["export namespace Shapes { }", "Shapes", "namespace"],
	])("%s extracts %s", (source, name, kind) => {
		expect(extractor.extract(source, "ts").symbols).toEqual([
			{ name, kind, line: 1 },
		]);
	});

	test("an abstract class contributes the class and every member", () => {
		const symbols = extractor.extract(
			"export abstract class BaseService {\n" +
				"\trun() {}\n" +
				"\tabstract go(): void;\n" +
				"}",
			"ts",
		).symbols;
		expect(symbols).toEqual([
			{ name: "BaseService", kind: "class", line: 1 },
			{ name: "BaseService.run", kind: "method", line: 2 },
			{ name: "BaseService.go", kind: "method", line: 3 },
		]);
	});

	test("a class field holding an arrow is a member of its class", () => {
		expect(names("class A { handle = () => {} }")).toEqual(["A", "A.handle"]);
	});

	// L20: same name, same line, and previously the same kind — two rows no
	// reader could tell apart.
	test("a getter and its setter are distinguishable rows", () => {
		const symbols = extractor.extract(
			"class A { get v() { return 1 } set v(n) {} }",
			"ts",
		).symbols;
		expect(symbols).toEqual([
			{ name: "A", kind: "class", line: 1 },
			{ name: "A.v", kind: "getter", line: 1 },
			{ name: "A.v", kind: "setter", line: 1 },
		]);
	});

	test("the most specific pattern names an exported binding once", () => {
		expect(
			extractor.extract("export const f = () => {};", "ts").symbols,
		).toEqual([{ name: "f", kind: "arrow", line: 1 }]);
	});
});

// M14: a lazily loaded route contributed nothing, so get_impact under-reported
// exactly the boundaries where a change is riskiest.
describe("TsxExtractor import coverage", () => {
	test("a dynamic import produces an edge", () => {
		expect(
			extractor.extract("const m = () => import('./lazy');", "ts").imports,
		).toEqual(["./lazy"]);
	});

	test("import-equals-require produces an edge", () => {
		expect(
			extractor.extract("import legacy = require('./legacy');", "ts").imports,
		).toEqual(["./legacy"]);
	});
});

// H11: `<T>expr` is a type assertion in .ts and a JSX element in .tsx, which is
// why the two grammars exist. Parsed with the wrong one, the assertion becomes
// an ERROR node that swallows the rest of the file.
describe("TsxExtractor grammar selection", () => {
	const ASSERTION =
		"const el = <HTMLElement>document.body;\nexport function after(){}";

	test("a .ts angle-bracket assertion keeps every later symbol", () => {
		const extracted = extractor.extract(ASSERTION, "ts");
		expect(extracted.symbols.map((symbol) => symbol.name)).toEqual(["after"]);
		expect(extracted.hasError).toBe(false);
	});

	test("the same text parsed as .tsx is reported as a broken parse", () => {
		expect(extractor.extract(ASSERTION, "tsx").hasError).toBe(true);
	});

	test("JSX still parses under every non-.ts lang", () => {
		const source = "export const Badge = () => <span>hi</span>;";
		for (const lang of ["tsx", "jsx", "js"]) {
			const extracted = extractor.extract(source, lang);
			expect(extracted.hasError).toBe(false);
			expect(extracted.symbols.map((symbol) => symbol.name)).toEqual(["Badge"]);
		}
	});

	test("a syntax error anywhere is recorded rather than swallowed", () => {
		expect(extractor.extract("function broken( {", "ts").hasError).toBe(true);
	});
});
