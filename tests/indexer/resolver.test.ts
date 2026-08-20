import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
	resolver = ImportResolver.create(FIXTURE_ROOT, FIXTURE_FILES);
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
		const bare = ImportResolver.create(root, ["src/a.ts", "src/b.ts"]);
		expect(bare.resolve("src/a.ts", "./b").toPath).toBe("src/b.ts");
		expect(bare.resolve("src/a.ts", "src/b").toPath).toBeNull();
	});

	test("a malformed tsconfig degrades to no aliases", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(join(root, "tsconfig.json"), "{ not even close");
		const broken = ImportResolver.create(root, ["src/a.ts"]);
		expect(broken.resolve("src/x.ts", "anything").toPath).toBeNull();
	});

	test("paths without baseUrl work relative to the tsconfig", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			`{"compilerOptions":{"paths":{"#lib/*":["./lib/*"]}}}`,
		);
		const scoped = ImportResolver.create(root, ["lib/x.ts"]);
		expect(scoped.resolve("src/a.ts", "#lib/x").toPath).toBe("lib/x.ts");
		expect(scoped.resolve("src/a.ts", "lib/x").toPath).toBeNull();
	});

	test("malformed paths entries are ignored without throwing", async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-resolver-"));
		writeFileSync(
			join(root, "tsconfig.json"),
			`{"compilerOptions":{"baseUrl":42,"paths":{"bad":"not-array","ok/*":[1,"./src/*"]}}}`,
		);
		const tolerant = ImportResolver.create(root, ["src/y.ts"]);
		expect(tolerant.resolve("src/a.ts", "ok/y").toPath).toBe("src/y.ts");
		expect(tolerant.resolve("src/a.ts", "bad").toPath).toBeNull();
	});
});

// H7: reading one file and one key made every aliased import in a monorepo
// resolve to NULL — Nx, Turborepo, Angular and most `@/*` setups keep baseUrl
// and paths in a shared base config, so `get_impact` returned no code impact at
// all and doctor could only say "below 85%".
describe("tsconfig extends", () => {
	function project(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "cortex-extends-"));
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return root;
	}

	test("aliases declared in an extended base config still resolve", async () => {
		const root = project({
			"tsconfig.json": `{"extends": "./tsconfig.base.json"}`,
			"tsconfig.base.json": `{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});

	// A relative target means something different in every file that spells it,
	// so it is resolved against the directory of the config that declared it.
	test("a parent's paths are read against the parent's own directory", async () => {
		const root = project({
			"tsconfig.json": `{"extends": "./config/base.json"}`,
			"config/base.json": `{"compilerOptions":{"paths":{"~/*":["../src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "~/util").toPath).toBe(
			"src/util.ts",
		);
	});

	test("the chain is followed through more than one level", async () => {
		const root = project({
			"tsconfig.json": `{"extends": "./middle.json"}`,
			"middle.json": `{"extends": "./root-base.json"}`,
			"root-base.json": `{"compilerOptions":{"paths":{"@/*":["./src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});

	test("the nearest declaration of a key wins over its parent's", async () => {
		const root = project({
			"tsconfig.json": `{"extends":"./base.json","compilerOptions":{"paths":{"@/*":["./near/*"]}}}`,
			"base.json": `{"compilerOptions":{"paths":{"@/*":["./far/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, [
			"near/util.ts",
			"far/util.ts",
		]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"near/util.ts",
		);
	});

	test("the last entry of an extends array overrides the earlier ones", async () => {
		const root = project({
			"tsconfig.json": `{"extends":["./first.json","./second.json"]}`,
			"first.json": `{"compilerOptions":{"paths":{"@/*":["./first/*"]}}}`,
			"second.json": `{"compilerOptions":{"paths":{"@/*":["./second/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, [
			"first/util.ts",
			"second/util.ts",
		]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"second/util.ts",
		);
	});

	// The consumer's baseUrl is what a shared package's paths are read against,
	// which is the only reading that lets one published config serve every
	// package that extends it.
	test("a bare extends is resolved through node_modules", async () => {
		const root = project({
			"tsconfig.json": `{"extends":"@acme/tsconfig","compilerOptions":{"baseUrl":"."}}`,
			"node_modules/@acme/tsconfig/tsconfig.json": `{"compilerOptions":{"paths":{"@/*":["src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});

	test("a bare extends naming a file of its own is honoured", async () => {
		const root = project({
			"tsconfig.json": `{"extends":"@acme/configs/strict.json","compilerOptions":{"baseUrl":"."}}`,
			"node_modules/@acme/configs/strict.json": `{"compilerOptions":{"paths":{"@/*":["src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});

	test("an extends that resolves to nothing degrades to no aliases", async () => {
		const root = project({
			"tsconfig.json": `{"extends": ["@absent/tsconfig", "./gone.json", 7]}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBeNull();
	});

	test("a cycle in the chain terminates", async () => {
		const root = project({
			"tsconfig.json": `{"extends":"./a.json"}`,
			"a.json": `{"extends":"./b.json"}`,
			"b.json": `{"extends":"./a.json","compilerOptions":{"paths":{"@/*":["./src/*"]}}}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});

	test("a tsconfig whose root is not an object degrades to no aliases", async () => {
		const root = project({ "tsconfig.json": "[]" });
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBeNull();
	});

	// L23: read through the ESM module cache, an edited tsconfig kept its old
	// aliases for the life of the process — which for the MCP server means until
	// someone restarts it.
	test("an edited tsconfig is seen without restarting the process", async () => {
		const root = project({
			"tsconfig.json": `{"compilerOptions":{"paths":{"@/*":["./before/*"]}}}`,
		});
		const before = ImportResolver.create(root, ["after/util.ts"]);
		expect(before.resolve("src/main.ts", "@/util").toPath).toBeNull();

		writeFileSync(
			join(root, "tsconfig.json"),
			`{"compilerOptions":{"paths":{"@/*":["./after/*"]}}}`,
		);
		const after = ImportResolver.create(root, ["after/util.ts"]);

		expect(after.resolve("src/main.ts", "@/util").toPath).toBe("after/util.ts");
	});

	test("comments and trailing commas are tolerated in the chain", async () => {
		const root = project({
			"tsconfig.json": `{
				// the base holds the paths
				"extends": "./base.json",
			}`,
			"base.json": `{"compilerOptions":{"paths":{"@/*":["./src/*",],},},}`,
		});
		const resolver = ImportResolver.create(root, ["src/util.ts"]);

		expect(resolver.resolve("src/main.ts", "@/util").toPath).toBe(
			"src/util.ts",
		);
	});
});
