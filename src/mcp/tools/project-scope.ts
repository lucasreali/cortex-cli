import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { errorResult, guidanceResult } from "./results";

const RESOLUTION_HINT =
	"Absolute path to the project to target — any directory inside it works; " +
	"the nearest .cortex/ store is resolved walking up from it.";

export function projectPathField(registry: RuntimeRegistry) {
	const field = z.string().min(1);
	if (registry.hasDefaultProject) {
		return field
			.optional()
			.describe(
				`${RESOLUTION_HINT} Omit to use the project the server started in.`,
			);
	}
	return field.describe(
		`${RESOLUTION_HINT} Required: this server started outside any ` +
			"initialized project, so there is no default.",
	);
}

// Every tool goes through here, so this is where the two answer shapes are
// decided: a recoverable state is guidance the agent can act on, and only a
// genuine fault is an isError the SDK would otherwise shape differently per
// tool depending on whether that tool happened to catch.
export function scopedToProject<Args extends { projectPath?: string }>(
	registry: RuntimeRegistry,
	handler: (
		runtime: CortexRuntime,
		args: Omit<Args, "projectPath">,
	) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
	return async ({ projectPath, ...args }) => {
		const resolution = await registry.resolve(projectPath);
		if (!resolution.ok) {
			return guidanceResult("not_initialized", resolution.guidance);
		}
		try {
			return await handler(resolution.runtime, args);
		} catch (error) {
			return errorResult(error);
		}
	};
}
