import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = new URL("../../src/mcp/server.ts", import.meta.url)
	.pathname;
const CLI_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;

let alpha: string;
let beta: string;
let bare: string;
let alphaClient: Client;
let bareClient: Client;

function run(cwd: string, ...command: string[]): void {
	const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	}
}

function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function makeProject(prefix: string, remote: string): string {
	const dir = makeTempDir(prefix);
	run(dir, "git", "init", "-b", "main");
	run(dir, "git", "remote", "add", "origin", remote);
	run(dir, "bun", CLI_PATH, "init", "--yes");
	return dir;
}

async function connect(cwd: string): Promise<Client> {
	const client = new Client({ name: "multi-e2e", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: "bun",
			args: [SERVER_PATH],
			cwd,
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
		}),
	);
	return client;
}

async function callTool(
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

async function toolSchema(client: Client, name: string) {
	const tools = await client.listTools();
	const tool = tools.tools.find((entry) => entry.name === name);
	if (!tool) throw new Error(`tool not listed: ${name}`);
	return tool.inputSchema as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
}

beforeAll(async () => {
	alpha = makeProject("cortex-alpha-", "git@github.com:acme/alpha.git");
	beta = makeProject("cortex-beta-", "git@github.com:acme/beta.git");
	mkdirSync(join(beta, "src"), { recursive: true });
	bare = makeTempDir("cortex-bare-");
	alphaClient = await connect(alpha);
	bareClient = await connect(bare);
}, 30_000);

afterAll(async () => {
	await alphaClient?.close();
	await bareClient?.close();
	for (const dir of [alpha, beta, bare]) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("multi-project MCP server with a default project", () => {
	let alphaDecision: string;
	let betaDecision: string;

	test("projectPath is exposed but optional on every tool", async () => {
		const tools = await alphaClient.listTools();
		for (const tool of tools.tools) {
			const schema = tool.inputSchema as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			expect(schema.properties?.projectPath).toBeDefined();
			expect(schema.required ?? []).not.toContain("projectPath");
		}
	});

	test("save_decision routes to the default and to an explicit project", async () => {
		const inAlpha = await callTool(alphaClient, "save_decision", {
			title: "Adotar Postgres para persistência",
			body: "Postgres com uma instância única cobre o volume atual do serviço.",
			keywords: ["postgres", "database", "banco", "persistência", "storage"],
		});
		expect(inAlpha.isError).toBe(false);
		alphaDecision = inAlpha.payload.id;

		const inBeta = await callTool(alphaClient, "save_decision", {
			title: "Usar Redis para filas de eventos",
			body: "Redis Streams processa os eventos assíncronos com retries simples.",
			keywords: ["redis", "filas", "queue", "eventos", "events"],
			projectPath: join(beta, "src"),
		});
		expect(inBeta.isError).toBe(false);
		betaDecision = inBeta.payload.id;
	});

	test("get_context keeps each project's store isolated", async () => {
		const defaultContext = await callTool(alphaClient, "get_context", {});
		expect(defaultContext.payload.project).toBe("github.com/acme/alpha");
		const defaultIds = defaultContext.payload.decisions.map(
			(decision: { id: string }) => decision.id,
		);
		expect(defaultIds).toContain(alphaDecision);
		expect(defaultIds).not.toContain(betaDecision);

		const betaContext = await callTool(alphaClient, "get_context", {
			projectPath: join(beta, "src"),
		});
		expect(betaContext.payload.project).toBe("github.com/acme/beta");
		const betaIds = betaContext.payload.decisions.map(
			(decision: { id: string }) => decision.id,
		);
		expect(betaIds).toContain(betaDecision);
		expect(betaIds).not.toContain(alphaDecision);
	});

	test("search and get_impact reach the explicit project", async () => {
		const scoped = await callTool(alphaClient, "search", {
			terms: ["redis"],
			exact: true,
			projectPath: beta,
		});
		expect(
			scoped.payload.results.map((entry: { id: string }) => entry.id),
		).toContain(betaDecision);

		const unscoped = await callTool(alphaClient, "search", {
			terms: ["redis"],
			exact: true,
		});
		expect(unscoped.payload.results).toEqual([]);

		const impact = await callTool(alphaClient, "get_impact", {
			decision_id: betaDecision,
			projectPath: beta,
		});
		expect(impact.isError).toBe(false);
		expect(impact.payload.decision.id).toBe(betaDecision);
	});

	test("an uninitialized projectPath returns guidance, not an error", async () => {
		const result = await callTool(alphaClient, "get_context", {
			projectPath: bare,
		});
		expect(result.isError).toBe(false);
		expect(result.payload.status).toBe("not_initialized");
		expect(result.payload.guidance).toContain("cortex init");
	});
});

describe("multi-project MCP server without a default project", () => {
	test("schema marks projectPath required", async () => {
		const schema = await toolSchema(bareClient, "get_context");
		expect(schema.required ?? []).toContain("projectPath");
	});

	test("tools answer for an initialized project via projectPath", async () => {
		const context = await callTool(bareClient, "get_context", {
			projectPath: alpha,
		});
		expect(context.isError).toBe(false);
		expect(context.payload.project).toBe("github.com/acme/alpha");
	});

	test("a call omitting the required projectPath is rejected", async () => {
		const result = await callTool(bareClient, "get_context", {});
		expect(result.isError).toBe(true);
	});

	test("starting the server creates no store in the bare directory", () => {
		expect(
			Bun.spawnSync(["test", "-e", join(bare, ".cortex")]).exitCode,
		).not.toBe(0);
	});
});
