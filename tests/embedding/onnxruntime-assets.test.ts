import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EMBEDDED_ONNX_ASSETS,
	ensureOnnxRuntimeAssets,
	type OnnxRuntimeAssets,
} from "@/embedding/onnxruntime-assets";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cortex-onnx-"));
	tempDirs.push(dir);
	return dir;
}

interface HashedFixture {
	assets: OnnxRuntimeAssets;
	cacheDir: string;
}

function makeHashedAssets(): HashedFixture {
	const dir = makeTempDir();
	const assets = {
		module: join(dir, "ort-wasm-simd-threaded.asyncify-abc123.mjs"),
		binary: join(dir, "ort-wasm-simd-threaded.asyncify-abc123.wasm"),
	};
	writeFileSync(assets.module, "export default 'module';\n");
	writeFileSync(assets.binary, "wasm-bytes");
	return { assets, cacheDir: join(dir, "cache") };
}

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ensureOnnxRuntimeAssets", () => {
	test("the embedded assets resolve to real files", async () => {
		expect(await Bun.file(EMBEDDED_ONNX_ASSETS.module).exists()).toBe(true);
		expect(await Bun.file(EMBEDDED_ONNX_ASSETS.binary).exists()).toBe(true);
	});

	test("a canonical layout is used in place, without extraction", async () => {
		const directory = await ensureOnnxRuntimeAssets();
		expect(directory).toEndWith(
			join("node_modules", "onnxruntime-web", "dist"),
		);
	});

	test("hashed asset names are extracted under canonical names", async () => {
		const { assets, cacheDir } = makeHashedAssets();
		const directory = await ensureOnnxRuntimeAssets(assets, cacheDir);
		expect(directory).toBe(
			join(cacheDir, "ort-wasm-simd-threaded.asyncify-abc123"),
		);
		const moduleCopy = join(directory, "ort-wasm-simd-threaded.asyncify.mjs");
		const binaryCopy = join(directory, "ort-wasm-simd-threaded.asyncify.wasm");
		expect(await Bun.file(moduleCopy).text()).toBe(
			"export default 'module';\n",
		);
		expect(await Bun.file(binaryCopy).text()).toBe("wasm-bytes");
	});

	test("extraction is idempotent", async () => {
		const { assets, cacheDir } = makeHashedAssets();
		const directory = await ensureOnnxRuntimeAssets(assets, cacheDir);
		const binaryCopy = join(directory, "ort-wasm-simd-threaded.asyncify.wasm");
		const firstWrite = statSync(binaryCopy).mtimeMs;
		await ensureOnnxRuntimeAssets(assets, cacheDir);
		expect(statSync(binaryCopy).mtimeMs).toBe(firstWrite);
	});

	test("a size mismatch triggers re-extraction", async () => {
		const { assets, cacheDir } = makeHashedAssets();
		const directory = await ensureOnnxRuntimeAssets(assets, cacheDir);
		const binaryCopy = join(directory, "ort-wasm-simd-threaded.asyncify.wasm");
		writeFileSync(binaryCopy, "truncated");
		await ensureOnnxRuntimeAssets(assets, cacheDir);
		expect(await Bun.file(binaryCopy).text()).toBe("wasm-bytes");
	});

	test("canonical names split across directories still extract", async () => {
		const moduleDir = makeTempDir();
		const binaryDir = makeTempDir();
		const assets = {
			module: join(moduleDir, "ort-wasm-simd-threaded.asyncify.mjs"),
			binary: join(binaryDir, "ort-wasm-simd-threaded.asyncify.wasm"),
		};
		writeFileSync(assets.module, "module");
		writeFileSync(assets.binary, "binary");
		const cacheDir = join(makeTempDir(), "cache");
		const directory = await ensureOnnxRuntimeAssets(assets, cacheDir);
		expect(directory).toBe(join(cacheDir, "ort-wasm-simd-threaded.asyncify"));
		expect(
			await Bun.file(
				join(directory, "ort-wasm-simd-threaded.asyncify.wasm"),
			).text(),
		).toBe("binary");
	});
});
