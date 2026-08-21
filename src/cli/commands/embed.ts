import { parseArgs } from "node:util";
import type { CortexRuntime } from "@/app/runtime";
import { withRuntime } from "@/cli/open-runtime";
import { failure, style, success } from "@/cli/style";
import { usageError } from "@/cli/usage";
import { createDirectProvider } from "@/embedding/create-provider";
import { GEMMA_MODEL } from "@/embedding/model";
import { modelIsResident } from "@/embedding/model-cache";
import { modelsDir } from "@/embedding/models-dir";
import { readConfig, writeConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";
import { errorMessage } from "@/support/errors";
import { embedAll } from "./embed-all";

export async function runEmbed(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			missing: { type: "boolean", default: false },
			rebuild: { type: "boolean", default: false },
			yes: { type: "boolean", default: false },
			"fetch-model": { type: "boolean", default: false },
		},
	});
	if (values["fetch-model"]) {
		if (values.missing || values.rebuild) return usageError("embed");
		return fetchModel();
	}
	if (values.missing === values.rebuild) return usageError("embed");
	return withRuntime(cwd, (runtime) =>
		values.missing ? embedMissing(runtime) : rebuild(runtime, values.yes),
	);
}

// Acquisition is a fact about this machine, not about a project, so it skips
// the runtime entirely and runs outside any store. It also runs without a
// deadline: the embed timeouts exist to catch a wedged worker, and a person
// who no longer wants to wait for 300 MB can interrupt a command they invoked
// themselves — where a background embed cannot.
async function fetchModel(): Promise<number> {
	if (modelIsResident()) {
		console.log(style.dim(`Model already available: ${GEMMA_MODEL.modelId}`));
		return 0;
	}
	console.log(
		`Downloading ${GEMMA_MODEL.huggingFaceId} (about 300 MB) into ${modelsDir()}`,
	);
	const provider = createDirectProvider(GEMMA_MODEL.modelId);
	try {
		await provider.embedQuery("cortex model acquisition");
		console.log(success(`Embedding model ready: ${GEMMA_MODEL.modelId}`));
		return 0;
	} catch (error) {
		console.error(failure(`Model download failed: ${errorMessage(error)}`));
		return 1;
	} finally {
		provider.dispose();
	}
}

async function embedMissing(runtime: CortexRuntime): Promise<number> {
	const pending = runtime.embeddings.listMissingNodeIds(runtime.pinnedModelId);
	if (pending.length === 0) {
		console.log(style.dim("Nothing to embed."));
		return 0;
	}
	return embedAll(runtime, pending);
}

async function rebuild(
	runtime: CortexRuntime,
	assumeYes: boolean,
): Promise<number> {
	const active = runtime.nodes.listActive();
	if (!assumeYes && !confirmRebuild(active.length)) {
		console.error(failure("Rebuild needs confirmation — rerun with --yes."));
		return 1;
	}
	const code = await embedAll(
		runtime,
		active.map((decision) => decision.id),
	);
	if (code !== 0 || !runtime.provider) return code;

	const config = await readConfig(runtime.cortexDir);
	if (config?.model_id !== runtime.provider.modelId) {
		await writeConfig(runtime.cortexDir, {
			model_id: runtime.provider.modelId,
			schema_version: config?.schema_version ?? SCHEMA_VERSION,
		});
		console.log(
			success(`Config model_id updated to ${runtime.provider.modelId}`),
		);
	}
	return 0;
}

function confirmRebuild(count: number): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(`Re-embed all ${count} active decision(s)?`);
}
