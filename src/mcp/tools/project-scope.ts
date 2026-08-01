import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { guidanceResult } from "./results";

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

export function scopedToProject<Args extends Record<string, unknown>>(
	registry: RuntimeRegistry,
	handler: (runtime: CortexRuntime, args: Args) => Promise<CallToolResult>,
): (args: Args & { projectPath?: string }) => Promise<CallToolResult> {
	return async ({ projectPath, ...args }) => {
		const resolution = await registry.resolve(projectPath);
		if (!resolution.ok) {
			return guidanceResult("not_initialized", resolution.guidance);
		}
		return handler(resolution.runtime, args as unknown as Args);
	};
}
