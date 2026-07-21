import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImportResolver } from "@/indexer/import-resolver";

const FIXTURE_ROOT = join(import.meta.dir, "..", "fixtures", "resolver");

const FIXTURE_FILES = [
	"src/a.ts",
	"src/c.tsx",
	"src/d.js",
	"src/e.ts",
	"src/sub/index.ts",
	"src/lib/util.ts",
];

let resolver: ImportResolver;

beforeAll(async () => {
	resolver = await ImportResolver.create(FIXTURE_ROOT, FIXTURE_FILES);
});

describe("relative specifiers", () => {
	test("explicit extension pointing at an indexed file is exact", () => {
		expect(resolver.resolve("src/a.ts", "./d.js")).toEqual({
			toPath: "src/d.js",
			provenance: "exact",
		});
	});

	test("omitted extension tries ts/tsx/js/jsx in order", () => {
		expect(resolver.resolve("src/a.ts", "./e")).toEqual({
			toPath: "src/e.ts",
			provenance: "heuristic",
		});
		expect(resolver.resolve("src/a.ts", "./c")).toEqual({
			toPath: "src/c.tsx",
			provenance: "heuristic",
		});
	});

	test("a directory resolves to its index file", () => {
		expect(resolver.resolve("src/a.ts", "./sub")).toEqual({
			toPath: "src/sub/index.ts",
			provenance: "heuristic",
		});
	});

	test("NodeNext-style ./e.js resolves to the ts source", () => {
		expect(resolver.resolve("src/a.ts", "./e.js")).toEqual({
			toPath: "src/e.ts",
			provenance: "heuristic",
		});
	});

	test("paths escaping the repo root stay unresolved", () => {
		expect(resolver.resolve("src/a.ts", "../../../etc/passwd")).toEqual({
			toPath: null,
			provenance: "heuristic",
		});
	});

	test("a relative miss stays unresolved", () => {
		expect(resolver.resolve("src/a.ts", "./ghost")).toEqual({
			toPath: null,
			provenance: "heuristic",
		});
	});
});

describe("tsconfig aliases", () => {
	test("star patterns substitute into their targets", () => {
		expect(resolver.resolve("src/a.ts", "@app/lib/util")).toEqual({
			toPath: "src/lib/util.ts",
			provenance: "heuristic",
		});
	});

	test("exact aliases map straight to their target", () => {
		expect(resolver.resolve("src/a.ts", "utils")).toEqual({
			toPath: "src/lib/util.ts",
			provenance: "heuristic",
		});
	});

	test("baseUrl resolves bare specifiers from the root", () => {
		expect(resolver.resolve("src/a.ts", "src/sub")).toEqual({
			toPath: "src/sub/index.ts",
			provenance: "heuristic",
		});
	});

	test("npm and builtin specifiers stay unresolved", () => {
		for (const specifier of ["zod", "node:path", "@scope/pkg"]) {
			expect(resolver.resolve("src/a.ts", specifier).toPath).toBeNull();
		}
	});
});

describe("robustness", () => {
	test("weird specifiers never throw", () => {
		const weird = [
			"",
			".",
			"./",
			"..",
			"/etc/passwd",
			"data:text/plain,hello",
			"a\\b",
			"@app/",
			"./styles.css",
			"././//x",
		];
		for (const specifier of weird) {
			expect(() => resolver.resolve("src/a.ts", specifier)).not.toThrow();
		}
	});

	test("a repo without tsconfig still resolves relative imports", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		const bare = await ImportResolver.create(root, ["src/a.ts", "src/b.ts"]);
		expect(bare.resolve("src/a.ts", "./b").toPath).toBe("src/b.ts");
		expect(bare.resolve("src/a.ts", "src/b").toPath).toBeNull();
	});

	test("a malformed tsconfig degrades to no aliases", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(join(root, "tsconfig.json"), "{ not even close");
		const broken = await ImportResolver.create(root, ["src/a.ts"]);
		expect(broken.resolve("src/x.ts", "anything").toPath).toBeNull();
	});

	test("paths without baseUrl work relative to the tsconfig", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			`{"compilerOptions":{"paths":{"#lib/*":["./lib/*"]}}}`,
		);
		const scoped = await ImportResolver.create(root, ["lib/x.ts"]);
		expect(scoped.resolve("src/a.ts", "#lib/x").toPath).toBe("lib/x.ts");
		expect(scoped.resolve("src/a.ts", "lib/x").toPath).toBeNull();
	});

	test("malformed paths entries are ignored without throwing", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			`{"compilerOptions":{"baseUrl":42,"paths":{"bad":"not-array","ok/*":[1,"./src/*"]}}}`,
		);
		const tolerant = await ImportResolver.create(root, ["src/y.ts"]);
		expect(tolerant.resolve("src/a.ts", "ok/y").toPath).toBe("src/y.ts");
		expect(tolerant.resolve("src/a.ts", "bad").toPath).toBeNull();
	});
});
