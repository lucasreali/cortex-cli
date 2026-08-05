import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CortexRuntime } from "@/app/runtime";
import type { RuntimeRegistry } from "@/mcp/runtime-registry";
import { projectPathField, scopedToProject } from "./project-scope";
import { jsonResult } from "./results";

const DESCRIPTION = `Persist a narrative summary of the current working session (Cortex).

Call this when the session ends, and again whenever a significant milestone lands mid-session. Structure the summary in three sections: "Implemented" (what was built or changed), "Decisions" (what was chosen, with the saved decision ids when they exist), and "Open" (what remains unfinished, blocked, or deferred). The "Open" section matters most — it is the only record of unfinished work the next session can recover.

Each call replaces the session's previous summary, so always send the complete current narrative, not a delta. Summaries are local to this machine and surface in get_context's overview; they are not versioned with the project's decision files.

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
	runtime.nodes.updateSessionSummary(sessionId, args.summary);
	return jsonResult({ session_id: sessionId });
}
