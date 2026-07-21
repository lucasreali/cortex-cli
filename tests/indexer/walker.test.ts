import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSourceFiles } from "@/indexer/source-walker";

let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-walker-")));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer): void {
	const absolute = join(dir, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: dir,
		stdout: "ignore",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
}

function foundPaths(): string[] {
	return listSourceFiles(dir).map((file) => file.path);
}

describe("listSourceFiles in a git repository", () => {
	beforeEach(() => {
		git("init", "-b", "main");
	});

	test("lists tracked and untracked sources, respecting .gitignore", () => {
		write(".gitignore", "ignored.ts\n");
		write("src/tracked.ts", "export const a = 1;\n");
		git("add", "src/tracked.ts");
		write("src/untracked.tsx", "export const b = 2;\n");
		write("ignored.ts", "export const c = 3;\n");

		expect(foundPaths()).toEqual(["src/tracked.ts", "src/untracked.tsx"]);
	});

	test("applies the fixed exclusions even for listed paths", () => {
		write("src/app.ts", "export const a = 1;\n");
		write("node_modules/pkg/index.js", "module.exports = {};\n");
		write("dist/bundle.js", "var a;\n");
		write("build/out.js", "var b;\n");
		write(".cortex/tool.ts", "export {};\n");

		expect(foundPaths()).toEqual(["src/app.ts"]);
	});

	test("skips non-source extensions, oversized files and deleted tracked files", () => {
		write("README.md", "# docs\n");
		write("src/big.ts", Buffer.alloc(1024 * 1024 + 1, 0x20));
		write("src/kept.ts", "export const a = 1;\n");
		write("src/gone.ts", "export const b = 2;\n");
		git("add", "src/gone.ts");
		rmSync(join(dir, "src/gone.ts"));

		expect(foundPaths()).toEqual(["src/kept.ts"]);
	});

	test("reports language, size and mtime for each file", () => {
		const content = "export const a = 1;\n";
		write("src/app.cts", content);
		const [file] = listSourceFiles(dir);

		expect(file?.lang).toBe("ts");
		expect(file?.size).toBe(content.length);
		expect(file?.mtime).toBeGreaterThan(0);
	});
});

describe("listSourceFiles outside a git repository", () => {
	test("walks the directory tree with the same filters", () => {
		write("src/deep/module.ts", "export const a = 1;\n");
		write("src/view.jsx", "export const b = 2;\n");
		write("main.mjs", "export const c = 3;\n");
		write("node_modules/pkg/index.js", "module.exports = {};\n");
		write("docs/notes.md", "# notes\n");

		expect(foundPaths()).toEqual([
			"main.mjs",
			"src/deep/module.ts",
			"src/view.jsx",
		]);
	});
});
