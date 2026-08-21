import { parseArgs } from "node:util";
import { usageError } from "@/cli/error-output";
import { serveStdio } from "@/mcp/server";

export async function runServe(
	args: string[],
	cwd: string,
): Promise<number | null> {
	const { values } = parseArgs({
		args,
		options: { mcp: { type: "boolean", default: false } },
	});
	if (!values.mcp) return usageError("serve");
	await serveStdio(cwd);
	// The stdio transport keeps reading stdin; returning null skips
	// process.exit so the server stays alive until the client closes.
	return null;
}
