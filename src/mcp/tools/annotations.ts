import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// Declaring the contract lets permission-gating clients run these tools
// without prompting.
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
