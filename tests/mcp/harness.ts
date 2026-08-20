import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const SERVER_PATH = new URL("../../src/mcp/server.ts", import.meta.url)
	.pathname;
export const CLI_PATH = new URL("../../src/cli/main.ts", import.meta.url)
	.pathname;

export function run(cwd: string, ...command: string[]): void {
	runWithEnv(cwd, {}, ...command);
}

export function runWithEnv(
	cwd: string,
	env: Record<string, string>,
	...command: string[]
): void {
	const result = Bun.spawnSync(command, {
		cwd,
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	}
}

export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function makeProject(
	prefix: string,
	remote: string,
	env: Record<string, string> = {},
): string {
	const dir = makeTempDir(prefix);
	runWithEnv(dir, env, "git", "init", "-b", "main");
	runWithEnv(dir, env, "git", "remote", "add", "origin", remote);
	runWithEnv(dir, env, "bun", CLI_PATH, "init", "--yes");
	return dir;
}

// The server's own descriptors, so a test can assert that resolving many
// projects does not cost one open store each. Linux only.
export function serverDescriptors(client: Client): number {
	const pid = (client.transport as { pid?: number | null } | undefined)?.pid;
	if (typeof pid !== "number")
		throw new Error("no server pid on the transport");
	return readdirSync(`/proc/${pid}/fd`).length;
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
