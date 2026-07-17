import { parseArgs } from "node:util";
import { openInitializedRuntime } from "../open-runtime";

const DEFAULT_DEPTH = 3;

export async function runImpact(args: string[], cwd: string): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { depth: { type: "string" } },
		allowPositionals: true,
	});
	const id = positionals[0];
	if (!id) {
		console.error("usage: cortex impact <id> [--depth N]");
		return 1;
	}
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const root = runtime.nodes.getById(id);
		if (!root) {
			console.error(`decision not found: ${id}`);
			return 1;
		}
		console.log(`${root.title} (${root.id})`);
		const depth = values.depth ? Number(values.depth) : DEFAULT_DEPTH;
		for (const entry of runtime.edges.getImpact(id, depth)) {
			const node = runtime.nodes.getById(entry.nodeId);
			if (!node) continue;
			const marker = node.status === "replaced" ? " [replaced]" : "";
			console.log(
				`${"  ".repeat(entry.depth)}└─ ${node.title}${marker} (${node.id})`,
			);
		}
		return 0;
	} finally {
		runtime.dispose();
	}
}
