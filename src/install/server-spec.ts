export interface McpServerSpec {
	command: string;
	args: string[];
}

export interface ServerResolution {
	spec: McpServerSpec;
	warning: string | null;
}

export interface ServerSpecInput {
	compiled: boolean;
	binaryPath: string;
	onPath: string | null;
}

const SERVE_ARGS = ["serve", "--mcp"];

// A compiled binary registers itself by absolute path: GUI harnesses such as
// Cursor spawn MCP servers without a login-shell PATH. A source checkout has
// no durable path to offer, so it registers "cortex" and warns when nothing
// on PATH will answer to it.
export function resolveServerSpec(input: ServerSpecInput): ServerResolution {
	if (input.compiled) {
		return {
			spec: { command: input.binaryPath, args: [...SERVE_ARGS] },
			warning: null,
		};
	}
	return {
		spec: { command: "cortex", args: [...SERVE_ARGS] },
		warning: input.onPath
			? null
			: "cortex is not on PATH — the registered server will not start " +
				"until the compiled binary is installed",
	};
}
