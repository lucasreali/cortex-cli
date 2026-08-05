import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_PATH = new URL("../../src/mcp/server.ts", import.meta.url)
	.pathname;
export const CLI_PATH = new URL("../../src/cli/main.ts", import.meta.url)
	.pathname;

export function run(cwd: string, ...command: string[]): void {
	const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	}
}

export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function makeProject(prefix: string, remote: string): string {
	const dir = makeTempDir(prefix);
	run(dir, "git", "init", "-b", "main");
	run(dir, "git", "remote", "add", "origin", remote);
	run(dir, "bun", CLI_PATH, "init", "--yes");
	return dir;
}

export async function connect(
	cwd: string,
	env: Record<string, string> = {},
): Promise<Client> {
	const client = new Client({ name: "cortex-e2e", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: "bun",
			args: [SERVER_PATH],
			cwd,
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", ...env },
		}),
	);
	return client;
}

export async function callTool(
	client: Client,
	name: string,
	args: Record<string, unknown>,
) {
	let result: Awaited<ReturnType<Client["callTool"]>>;
	try {
		result = await client.callTool({ name, arguments: args });
	} catch (error) {
		return { isError: true, payload: null, message: String(error) };
	}
	const content = result.content as Array<{ type: string; text: string }>;
	const text = content[0]?.text ?? "";
	if (result.isError === true) {
		return { isError: true, payload: null, message: text };
	}
	return { isError: false, payload: JSON.parse(text), message: text };
}

export async function toolSchema(client: Client, name: string) {
	const tools = await client.listTools();
	const tool = tools.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`tool not listed: ${name}`);
	return tool.inputSchema as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
}
