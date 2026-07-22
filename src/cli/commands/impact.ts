import { parseArgs } from "node:util";
import type { Decision } from "@/domain";
import type { CortexRuntime } from "@/mcp/runtime";
import { CodeImpactAnalysis } from "@/storage/code-impact";
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
		const depth = values.depth ? Number(values.depth) : DEFAULT_DEPTH;
		printDependsOnTree(runtime, root, depth);
		await printCodeImpact(runtime, root, depth);
		return 0;
	} finally {
		runtime.dispose();
	}
}

function printDependsOnTree(
	runtime: CortexRuntime,
	root: Decision,
	depth: number,
): void {
	console.log(`${root.title} (${root.id})`);
	for (const entry of runtime.edges.getImpact(root.id, depth)) {
		const node = runtime.nodes.getById(entry.nodeId);
		if (!node) continue;
		const marker = node.status === "replaced" ? " [replaced]" : "";
		console.log(
			`${"  ".repeat(entry.depth)}└─ ${node.title}${marker} (${node.id})`,
		);
	}
}

async function printCodeImpact(
	runtime: CortexRuntime,
	root: Decision,
	depth: number,
): Promise<void> {
	if (root.anchors.length === 0) return;
	let impacted: ReturnType<CodeImpactAnalysis["forDecision"]>;
	try {
		const code = await runtime.codeIndex.repository();
		impacted = new CodeImpactAnalysis(runtime.nodes, code).forDecision(
			root,
			depth,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`\nCode impact unavailable: ${message}`);
		return;
	}
	if (impacted.length === 0) return;
	console.log("\nVia code (imports):");
	for (const entry of impacted) {
		console.log(
			`  ${entry.filePath} (${entry.depth} hop${entry.depth === 1 ? "" : "s"}, ${entry.provenance})`,
		);
		console.log(`    └─ ${entry.decision.title} (${entry.decision.id})`);
	}
}
