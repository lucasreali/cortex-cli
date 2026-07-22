import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// Query tools read the store and never mutate the workspace. Declaring the
// contract lets permission-gating clients run them without prompting.
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
