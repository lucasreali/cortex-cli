import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CORTEX_VERSION } from "@/version";
import { RuntimeRegistry } from "./runtime-registry";
import { registerGetContext } from "./tools/get-context";
import { registerGetDecision } from "./tools/get-decision";
import { registerGetImpact } from "./tools/get-impact";
import { registerSaveDecision } from "./tools/save-decision";
import { registerSaveSessionSummary } from "./tools/save-session-summary";
import { registerSearch } from "./tools/search";
import { registerSearchAllProjects } from "./tools/search-all-projects";

export function createServer(registry: RuntimeRegistry): McpServer {
	const server = new McpServer({ name: "cortex", version: CORTEX_VERSION });
	registerSaveDecision(server, registry);
	registerSaveSessionSummary(server, registry);
	registerGetContext(server, registry);
	registerGetDecision(server, registry);
	registerGetImpact(server, registry);
	registerSearch(server, registry);
	registerSearchAllProjects(server, registry);
	return server;
}

export async function serveStdio(cwd: string): Promise<void> {
	const registry = RuntimeRegistry.fromCwd(cwd);
	const server = createServer(registry);
	closeWith(server, registry, process.stdin);
	await server.connect(new StdioServerTransport());
}

// Every resolved project holds an open decisions.db, a lazy code.db and either
// a worker subprocess or a daemon socket, so a client that goes away has to
// release them and end the process. The SDK's stdio transport never notices a
// closed stdin on its own: a client that crashed or was killed with -9 left the
// server, its daemon connection and a private worker holding ~1.3 GB alive
// indefinitely. End of input is the one signal every way of leaving sends.
function closeWith(
	server: McpServer,
	registry: RuntimeRegistry,
	input: NodeJS.ReadableStream,
): void {
	let releasing: Promise<void> | null = null;
	const release = (): Promise<void> => {
		releasing ??= registry.dispose();
		return releasing;
	};
	// Handling a signal suppresses the default termination, so the exit has to
	// be issued here once the stores are released.
	const releaseThenExit = (): void => {
		void release().finally(() => process.exit(0));
	};
	server.server.onclose = releaseThenExit;
	input.once("end", releaseThenExit);
	input.once("close", releaseThenExit);
	process.once("SIGINT", releaseThenExit);
	process.once("SIGTERM", releaseThenExit);
}

if (import.meta.main) {
	await serveStdio(process.cwd());
}
