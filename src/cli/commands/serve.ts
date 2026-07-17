import { serveStdio } from "@/mcp/server";

export async function runServe(
	args: string[],
	cwd: string,
): Promise<number | null> {
	if (!args.includes("--mcp")) {
		console.error("usage: cortex serve --mcp");
		return 1;
	}
	await serveStdio(cwd);
	// The stdio transport keeps reading stdin; returning null skips
	// process.exit so the server stays alive until the client closes.
	return null;
}
