import { join } from "node:path";
import type { BunPlugin } from "bun";

export const ROOT = new URL("..", import.meta.url).pathname;
export const DEFAULT_OUTFILE = join(ROOT, "dist", "cortex");

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

export interface CompileRequest {
	outfile: string;
	target?: Bun.Build.CompileTarget;
	suffix?: string;
}

// The release asset suffix is baked in so `cortex upgrade` downloads the
// variant this binary was built as: musl and baseline builds are
// indistinguishable from the inside at runtime.
export async function compile({
	outfile,
	target,
	suffix,
}: CompileRequest): Promise<void> {
	const result = await Bun.build({
		entrypoints: [join(ROOT, "src", "cli", "main.ts")],
		compile: { outfile, ...(target ? { target } : {}) },
		sourcemap: "linked",
		plugins: [unavailableNativeModules],
		...(suffix
			? {
					define: {
						"process.env.CORTEX_BUILD_TARGET": JSON.stringify(suffix),
					},
				}
			: {}),
		throw: false,
	});
	for (const log of result.logs) {
		console.error(String(log));
	}
	if (!result.success) {
		throw new Error(`build failed for ${target ?? "host"}`);
	}
}
