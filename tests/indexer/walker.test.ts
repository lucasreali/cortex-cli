import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listSources } from "@/indexer/source-walker";

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
	return listSources(dir).files.map((file) => file.path);
}

describe("listSources in a git repository", () => {
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

	test("skips non-source extensions and deleted tracked files", () => {
		write("README.md", "# docs\n");
		write("src/kept.ts", "export const a = 1;\n");
		write("src/gone.ts", "export const b = 2;\n");
		git("add", "src/gone.ts");
		rmSync(join(dir, "src/gone.ts"));

		expect(foundPaths()).toEqual(["src/kept.ts"]);
		expect(listSources(dir).skipped).toEqual([]);
	});

	// An import can point at a file too large to parse, so dropping it from the
	// listing left every such import unresolved with no stated cause.
	test("keeps an oversized file listed and names it as skipped", () => {
		write("src/big.ts", Buffer.alloc(1024 * 1024 + 1, 0x20));
		write("src/kept.ts", "export const a = 1;\n");

		const listing = listSources(dir);

		expect(listing.files.map((file) => file.path)).toEqual([
			"src/big.ts",
			"src/kept.ts",
		]);
		expect(listing.skipped).toEqual([
			{
				path: "src/big.ts",
				reason: "larger than the 1048576-byte parse limit",
			},
		]);
	});

	test("a symlink cycle is one skipped file, not a failed listing", () => {
		write("src/kept.ts", "export const a = 1;\n");
		symlinkSync("cycle.ts", join(dir, "src/cycle.ts"));

		const listing = listSources(dir);

		expect(listing.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
		expect(listing.skipped).toHaveLength(1);
		expect(listing.skipped[0]?.path).toBe("src/cycle.ts");
		expect(listing.skipped[0]?.reason).toContain("ELOOP");
	});

	test("reports language, size and mtime for each file", () => {
		const content = "export const a = 1;\n";
		write("src/app.cts", content);
		const [file] = listSources(dir).files;

		expect(file?.lang).toBe("ts");
		expect(file?.size).toBe(content.length);
		expect(file?.mtime).toBeGreaterThan(0);
	});
});

describe("listSources outside a git repository", () => {
	// The walk is the only reader of these directories, so an unreadable one
	// aborted the whole index — and, through doctor's drift check, the whole
	// doctor run — over a single directory nobody asked it to descend into.
	test("an unreadable directory is skipped without aborting the walk", () => {
		write("src/kept.ts", "export const a = 1;\n");
		write("locked/hidden.ts", "export const b = 2;\n");
		chmodSync(join(dir, "locked"), 0o000);

		try {
			const listing = listSources(dir);

			expect(listing.files.map((file) => file.path)).toEqual(["src/kept.ts"]);
			expect(listing.skipped).toHaveLength(1);
			expect(listing.skipped[0]?.path).toBe("locked");
			expect(listing.skipped[0]?.reason).toContain("EACCES");
		} finally {
			chmodSync(join(dir, "locked"), 0o700);
		}
	});

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
