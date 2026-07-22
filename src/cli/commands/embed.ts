import { parseArgs } from "node:util";
import { decisionPassage } from "@/embedding/queue";
import type { CortexRuntime } from "@/app/runtime";
import { readConfig, writeConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";
import { openInitializedRuntime } from "../open-runtime";

export async function runEmbed(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			missing: { type: "boolean", default: false },
			rebuild: { type: "boolean", default: false },
			yes: { type: "boolean", default: false },
		},
	});
	if (values.missing === values.rebuild) {
		console.error("usage: cortex embed --missing | --rebuild [--yes]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		return values.missing
			? await embedMissing(runtime)
			: await rebuild(runtime, values.yes);
	} finally {
		runtime.dispose();
	}
}

async function embedMissing(runtime: CortexRuntime): Promise<number> {
	const pending = runtime.embeddings.listMissingNodeIds(runtime.pinnedModelId);
	if (pending.length === 0) {
		console.log("Nothing to embed.");
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
		console.error("Rebuild needs confirmation — rerun with --yes.");
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
		console.log(`Config model_id updated to ${runtime.provider.modelId}`);
	}
	return 0;
}

async function embedAll(
	runtime: CortexRuntime,
	nodeIds: string[],
): Promise<number> {
	const { provider } = runtime;
	if (!provider) {
		console.error(
			"Embeddings are disabled (CORTEX_DISABLE_EMBEDDINGS=1); cannot embed.",
		);
		return 1;
	}
	let done = 0;
	for (const nodeId of nodeIds) {
		const decision = runtime.nodes.getById(nodeId);
		if (!decision) continue;
		const [vector] = await provider.embedPassages([decisionPassage(decision)]);
		if (!vector) {
			console.error(`no vector returned for ${nodeId}`);
			return 1;
		}
		runtime.embeddings.upsert(nodeId, provider.modelId, vector);
		done++;
		console.log(`embedded ${done}/${nodeIds.length}  ${decision.title}`);
	}
	console.log(`Done: ${done} decision(s) embedded.`);
	return 0;
}

function confirmRebuild(count: number): boolean {
	if (!process.stdin.isTTY) return false;
	return confirm(`Re-embed all ${count} active decision(s)?`);
}
