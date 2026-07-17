import { parseArgs } from "node:util";
import { openInitializedRuntime } from "../open-runtime";

export async function runWhy(args: string[], cwd: string): Promise<number> {
	const { positionals } = parseArgs({ args, allowPositionals: true });
	const path = positionals[0];
	if (!path) {
		console.error("usage: cortex why <path>");
		return 1;
	}
	const runtime = openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const decisions = runtime.nodes.listByAnchorPath(path);
		if (decisions.length === 0) {
			console.log(`No decisions anchored to ${path}.`);
			return 0;
		}
		for (const decision of decisions) {
			const marker = decision.status === "replaced" ? " [replaced]" : "";
			console.log(
				`${decision.createdAt.slice(0, 10)}  ${decision.title}${marker} (${decision.id})`,
			);
		}
		return 0;
	} finally {
		runtime.dispose();
	}
}
