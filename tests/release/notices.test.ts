import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bundledPackages,
	type PackageNotice,
	readNotice,
	renderNotices,
} from "@scripts/notices";

const ROOT = new URL("../../", import.meta.url).pathname;

function sourcemap(sources: string[]): string {
	return JSON.stringify({ version: 3, sources, mappings: "" });
}

describe("bundledPackages", () => {
	test("names every package the bundler inlined, once, sorted", () => {
		const map = sourcemap([
			"src/cli/main.ts",
			"node_modules/zod/lib/index.js",
			"node_modules/@huggingface/transformers/dist/a.js",
			"node_modules/@huggingface/transformers/dist/b.js",
			"node_modules/ajv/dist/core.js",
		]);
		expect(bundledPackages(map, "")).toEqual([
			"@huggingface/transformers",
			"ajv",
			"zod",
		]);
	});

	// An entry the bundler synthesised — a stub in its own namespace, the entry
	// point itself — names no package and must not invent one.
	test("ignores sources that live outside node_modules", () => {
		const map = sourcemap([
			"unavailable-native:onnxruntime-node",
			"src/embedding/worker.ts",
			"node_modules/zod/index.js",
		]);
		expect(bundledPackages(map, "")).toEqual(["zod"]);
	});

	// A `type: "file"` import copies the asset whole, so the package it came
	// from is invisible to the sourcemap and would be redistributed unnamed.
	test("adds packages this repo imports as assets", () => {
		const source =
			'import onnx from "../../node_modules/onnxruntime-web/dist/ort.wasm" with {\n' +
			'\ttype: "file",\n};\n';
		expect(bundledPackages(sourcemap([]), source)).toEqual(["onnxruntime-web"]);
	});

	test("does not read a package name out of prose mentioning node_modules", () => {
		const source = "// walks upward through node_modules, then gives up\n";
		expect(bundledPackages(sourcemap([]), source)).toEqual([]);
	});

	test("refuses a sourcemap with no sources array", () => {
		expect(() => bundledPackages(JSON.stringify({ version: 3 }), "")).toThrow(
			"the bundle sourcemap has no sources array",
		);
	});
});

describe("readNotice", () => {
	let modules = "";
	let vendored = "";

	beforeAll(async () => {
		const root = mkdtempSync(join(tmpdir(), "cortex-notices-"));
		modules = join(root, "node_modules");
		vendored = join(root, "licenses");
		await Bun.write(
			join(modules, "shipped", "package.json"),
			JSON.stringify({ name: "shipped", license: "MIT" }),
		);
		await Bun.write(join(modules, "shipped", "LICENSE"), "MIT text\n");
		await Bun.write(join(modules, "shipped", "NOTICE"), "and a notice\n");
		await Bun.write(join(modules, "shipped", "README.md"), "not a license\n");
		await Bun.write(
			join(modules, "bare", "package.json"),
			JSON.stringify({ name: "bare", license: "MIT" }),
		);
		await Bun.write(join(vendored, "bare.txt"), "vendored text\n");
		await Bun.write(
			join(modules, "@scope", "silent", "package.json"),
			JSON.stringify({ name: "@scope/silent" }),
		);
	});

	afterAll(() => {
		rmSync(join(modules, ".."), { recursive: true, force: true });
	});

	test("reads every license-shaped file the package ships", async () => {
		const notice = await readNotice("shipped", modules, vendored);
		expect(notice).toEqual({
			name: "shipped",
			license: "MIT",
			text: "MIT text\n\nand a notice",
		});
	});

	test("falls back to the vendored text when the package ships none", async () => {
		const notice = await readNotice("bare", modules, vendored);
		expect(notice.text).toBe("vendored text");
	});

	// The whole point of the generator is that a missing notice cannot be
	// silent, so a package with neither is a packaging failure.
	test("refuses a package with no license text anywhere", async () => {
		expect(readNotice("@scope/silent", modules, vendored)).rejects.toThrow(
			"@scope/silent ships no license text and none is vendored at " +
				"scripts/licenses/@scope__silent.txt",
		);
	});

	test("records an undeclared license rather than dropping the package", async () => {
		await Bun.write(join(vendored, "@scope__silent.txt"), "some text\n");
		const notice = await readNotice("@scope/silent", modules, vendored);
		expect(notice.license).toBe("UNDECLARED");
	});
});

describe("renderNotices", () => {
	const notices: PackageNotice[] = [
		{ name: "zod", license: "MIT", text: "MIT text" },
		{ name: "@huggingface/transformers", license: "Apache-2.0", text: "Ap" },
	];

	test("names the version, every package and every license", () => {
		const rendered = renderNotices("v9.9.9", notices);
		expect(rendered).toContain("# Third-party notices — cortex v9.9.9");
		expect(rendered).toContain("## zod — MIT");
		expect(rendered).toContain("## @huggingface/transformers — Apache-2.0");
		expect(rendered).toContain("MIT text");
		expect(rendered.endsWith("\n")).toBe(true);
	});
});

// The generator is only worth having if it stays wired to the real tree: the
// dependency actually redistributed under Apache-2.0 has to reach it, and the
// two packages that ship no text at all have to be the two that are vendored.
describe("against this repository", () => {
	test("transformers.js and the ONNX Runtime packages carry their text", async () => {
		const modules = join(ROOT, "node_modules");
		const vendored = join(ROOT, "scripts", "licenses");
		const names = [
			"@huggingface/transformers",
			"onnxruntime-common",
			"onnxruntime-web",
		];
		const notices = await Promise.all(
			names.map((name) => readNotice(name, modules, vendored)),
		);
		expect(notices.map((notice) => notice.license)).toEqual([
			"Apache-2.0",
			"MIT",
			"MIT",
		]);
		for (const notice of notices) {
			expect(notice.text.length).toBeGreaterThan(200);
		}
	});
});
