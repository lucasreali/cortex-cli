import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RuntimeRegistry } from "./runtime-registry";
import { registerGetContext } from "./tools/get-context";
import { registerGetImpact } from "./tools/get-impact";
import { registerSaveDecision } from "./tools/save-decision";
import { registerSearch } from "./tools/search";

export function createServer(registry: RuntimeRegistry): McpServer {
	const server = new McpServer({ name: "cortex", version: "0.1.0" });
	registerSaveDecision(server, registry);
	registerGetContext(server, registry);
	registerGetImpact(server, registry);
	registerSearch(server, registry);
	return server;
}

export async function serveStdio(cwd: string): Promise<void> {
	const server = createServer(RuntimeRegistry.fromCwd(cwd));
	await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
	await serveStdio(process.cwd());
}
