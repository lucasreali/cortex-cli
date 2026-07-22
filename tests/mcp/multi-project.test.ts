import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	callTool,
	connect,
	makeProject,
	makeTempDir,
	toolSchema,
} from "./harness";

let alpha: string;
let beta: string;
let bare: string;
let alphaClient: Client;
let bareClient: Client;

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
