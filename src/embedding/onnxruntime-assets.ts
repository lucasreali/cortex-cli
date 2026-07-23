import { renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
// onnxruntime-web does not export ./dist/* through its exports map, so the
// two runtime files the WASM backend loads must be reached by relative path.
import onnxModule from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs" with {
	type: "file",
};
import onnxBinary from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm" with {
	type: "file",
};

export interface OnnxRuntimeAssets {
	module: string;
	binary: string;
}

export const EMBEDDED_ONNX_ASSETS: OnnxRuntimeAssets = {
	module: onnxModule,
	binary: onnxBinary,
};

const CANONICAL_MODULE = "ort-wasm-simd-threaded.asyncify.mjs";
const CANONICAL_BINARY = "ort-wasm-simd-threaded.asyncify.wasm";

// onnxruntime resolves both files by their canonical names under a single
// `wasmPaths` directory, and the .mjs half is loaded with a dynamic import —
// which requires a real on-disk file. When running from source the imports
// above resolve to node_modules and already satisfy both constraints; inside
// a compiled binary they resolve to content-hashed names in the embedded
// filesystem and must be extracted first.
export async function ensureOnnxRuntimeAssets(
	assets: OnnxRuntimeAssets = EMBEDDED_ONNX_ASSETS,
	cacheDir: string = join(homedir(), ".cortex", "onnxruntime"),
): Promise<string> {
	if (hasCanonicalLayout(assets)) return dirname(assets.module);
	const directory = join(cacheDir, cacheKey(assets));
	await extract(assets.module, join(directory, CANONICAL_MODULE));
	await extract(assets.binary, join(directory, CANONICAL_BINARY));
	return directory;
}

function hasCanonicalLayout(assets: OnnxRuntimeAssets): boolean {
	if (dirname(assets.module) !== dirname(assets.binary)) return false;
	return (
		basename(assets.module) === CANONICAL_MODULE &&
		basename(assets.binary) === CANONICAL_BINARY
	);
}

// The bundler's default asset naming appends a content hash, so the extracted
// directory changes (and is rebuilt) whenever onnxruntime-web changes.
function cacheKey(assets: OnnxRuntimeAssets): string {
	return basename(assets.binary, ".wasm");
}

async function extract(sourcePath: string, targetPath: string): Promise<void> {
	const source = Bun.file(sourcePath);
	if (Bun.file(targetPath).size === source.size) return;
	const staging = `${targetPath}.${process.pid}.partial`;
	await Bun.write(staging, source);
	// rename is atomic on the same filesystem, so concurrent workers cannot
	// observe a half-written file.
	renameSync(staging, targetPath);
}
