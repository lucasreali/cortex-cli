import { join } from "node:path";
import type { BunPlugin } from "bun";

const ROOT = new URL("..", import.meta.url).pathname;
const OUTFILE = join(ROOT, "dist", "cortex");

// transformers.js's node build imports its native backends (sharp for image
// pipelines, onnxruntime-node for native inference) at module top level, and
// neither exists outside node_modules. cortex pins the WASM execution
// provider at runtime and never touches them, so the compiled binary ships
// throwing stubs instead of native addons.
const unavailableNativeModules: BunPlugin = {
	name: "unavailable-native-modules",
	setup(build) {
		build.onResolve({ filter: /^(sharp|onnxruntime-node)$/ }, (args) => ({
			path: args.path,
			namespace: "unavailable-native",
		}));
		build.onLoad({ filter: /.*/, namespace: "unavailable-native" }, (args) => ({
			loader: "js",
			contents:
				"export default function unavailable() {" +
				` throw new Error("${args.path} is not bundled in the cortex binary");` +
				" }",
		}));
	},
};

const result = await Bun.build({
	entrypoints: [join(ROOT, "src", "cli", "main.ts")],
	compile: { outfile: OUTFILE },
	sourcemap: "linked",
	plugins: [unavailableNativeModules],
	throw: false,
});

for (const log of result.logs) {
	console.error(String(log));
}
if (!result.success) {
	console.error("build failed");
	process.exit(1);
}
const size = Bun.file(OUTFILE).size;
console.log(`${OUTFILE} (${(size / 1024 / 1024).toFixed(1)} MB)`);
