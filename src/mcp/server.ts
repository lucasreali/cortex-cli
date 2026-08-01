import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CORTEX_VERSION } from "@/version";
import { RuntimeRegistry } from "./runtime-registry";
import { registerGetContext } from "./tools/get-context";
import { registerGetImpact } from "./tools/get-impact";
import { registerSaveDecision } from "./tools/save-decision";
import { registerSearch } from "./tools/search";

export function createServer(registry: RuntimeRegistry): McpServer {
	const server = new McpServer({ name: "cortex", version: CORTEX_VERSION });
	registerSaveDecision(server, registry);
	registerGetContext(server, registry);
	registerGetImpact(server, registry);
	registerSearch(server, registry);
	return server;
}

export async function serveStdio(cwd: string): Promise<void> {
	const registry = RuntimeRegistry.fromCwd(cwd);
	const server = createServer(registry);
	closeWith(server, registry);
	await server.connect(new StdioServerTransport());
}

// Every resolved project holds an open decisions.db, a lazy code.db and either
// a worker subprocess or a daemon socket, so a client disconnect has to release
// them: the process may outlive the session, and the transport never exits.
function closeWith(server: McpServer, registry: RuntimeRegistry): void {
	let releasing: Promise<void> | null = null;
	const release = (): Promise<void> => {
		releasing ??= registry.dispose();
		return releasing;
	};
	server.server.onclose = release;
	// Handling a signal suppresses the default termination, so the exit has to
	// be issued here once the stores are released.
	const releaseThenExit = (): void => {
		void release().finally(() => process.exit(0));
	};
	process.once("SIGINT", releaseThenExit);
	process.once("SIGTERM", releaseThenExit);
}

if (import.meta.main) {
	await serveStdio(process.cwd());
}
