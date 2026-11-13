import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const DESCRIPTION = `Persist a narrative of the current session (Cortex), at the end and at milestones.

Use three sections: "Implemented", "Decisions" (with saved ids) and "Open" — what remains unfinished, which is how the next session recovers it. Each call replaces the session's previous summary, so send the whole narrative. Summaries are local to this machine (.cortex/local/), never versioned, and appear in get_context's overview.

Returns { session_id }.`;

export function registerSaveSessionSummary(
	server: McpServer,
	registry: RuntimeRegistry,
): void {
	server.registerTool(
		"save_session_summary",
		{
			description: DESCRIPTION,
			inputSchema: {
				summary: z
					.string()
					.min(30)
					.max(4000)
					.describe(
						'Complete session narrative with "Implemented", "Decisions" and "Open" sections. Replaces the previous summary for this session.',
					),
				projectPath: projectPathField(registry),
			},
		},
		scopedToProject(registry, saveSessionSummary),
	);
}

async function saveSessionSummary(
	runtime: CortexRuntime,
	args: { summary: string },
) {
	const sessionId = runtime.ensureSession();
	runtime.sessionSummaries.record(sessionId, args.summary);
	return jsonResult({ session_id: sessionId });
}
