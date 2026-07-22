import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildRuntime, type CortexRuntime } from "@/app/runtime";
import { registerGetContext } from "./tools/get-context";
import { registerGetImpact } from "./tools/get-impact";
import { registerSaveDecision } from "./tools/save-decision";
import { registerSearch } from "./tools/search";

export function createServer(runtime: CortexRuntime): McpServer {
	const server = new McpServer({ name: "cortex", version: "0.1.0" });
	registerSaveDecision(server, runtime);
	registerGetContext(server, runtime);
	registerGetImpact(server, runtime);
	registerSearch(server, runtime);
	return server;
}

export async function serveStdio(cwd: string): Promise<void> {
	const runtime = await buildRuntime(cwd);
	embedPulledDecisions(runtime);
	const server = createServer(runtime);
	await server.connect(new StdioServerTransport());
}

// Decisions arriving via git pull land without local embeddings; the
// long-lived server hydrates them in the background instead of leaving
// them keyword-only until someone runs `cortex embed --missing`.
function embedPulledDecisions(runtime: CortexRuntime): void {
	if (!runtime.queue) return;
	for (const nodeId of runtime.embeddings.listMissingNodeIds(
		runtime.pinnedModelId,
	)) {
		runtime.queue.enqueue(nodeId);
	}
}

if (import.meta.main) {
	await serveStdio(process.cwd());
}
