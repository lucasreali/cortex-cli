import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { UsefulnessEvent } from "@/usefulness/event";
import { CLI_PATH, callTool, connect, makeTempDir, run } from "./harness";

let dir: string;
let client: Client;
let jwtId: string;
let postgresId: string;

const jwt = {
	title: "Adotar JWT para login",
	body: "Tokens de acesso assinados com RS256, refresh rotacionado em cookie.",
	keywords: ["jwt", "login", "token", "autenticação", "segurança"],
};

const postgres = {
	title: "PostgreSQL como banco principal",
	body: "Escolhido pelo suporte a JSON e às migrations declarativas.",
	keywords: ["postgres", "banco", "database", "sql", "migrations"],
};

function logPath(): string {
	return join(dir, ".cortex", "local", "usefulness.jsonl");
}

function events(): UsefulnessEvent[] {
	return readFileSync(logPath(), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as UsefulnessEvent);
}

function decisionFiles(): Record<string, string> {
	const decisions = join(dir, ".cortex", "decisions");
	return Object.fromEntries(
		readdirSync(decisions).map((name) => [
			name,
			readFileSync(join(decisions, name), "utf8"),
		]),
	);
}

beforeAll(async () => {
	dir = makeTempDir("cortex-usefulness-mcp-");
	run(dir, "git", "init", "-b", "main");
	run(dir, "git", "remote", "add", "origin", "git@github.com:acme/demo.git");
	run(dir, "bun", CLI_PATH, "init", "--yes");
	client = await connect(dir);
	const saved = await callTool(client, "save_decision", jwt);
	jwtId = saved.payload.id;
	const other = await callTool(client, "save_decision", postgres);
	postgresId = other.payload.id;
}, 30_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("usefulness sidecar over the real MCP surface", () => {
	test("get_context with an intent records what it showed", async () => {
		const result = await callTool(client, "get_context", { intent: "login" });

		expect(result.payload.decisions.length).toBeGreaterThan(0);
		expect(events()).toContainEqual(
			expect.objectContaining({ decision: jwtId, kind: "shown" }),
		);
	});

	test("the overview records nothing — browsing is not a judgement", async () => {
		const before = events().length;

		await callTool(client, "get_context", {});

		expect(events()).toHaveLength(before);
	});

	test("get_impact records the decision as used", async () => {
		await callTool(client, "get_impact", { decision_id: jwtId });

		expect(events()).toContainEqual(
			expect.objectContaining({ decision: jwtId, kind: "used" }),
		);
	});

	test("shown and used carry the same session", () => {
		expect(new Set(events().map((event) => event.session)).size).toBe(1);
	});

	test("save_decision records the decisions it links to", async () => {
		await callTool(client, "save_decision", {
			title: "Sessões no Redis",
			body: "Cache de sessão fora do banco principal.",
			keywords: ["redis", "cache", "sessão", "session", "memória"],
			depends_on: [postgresId],
		});

		expect(events()).toContainEqual(
			expect.objectContaining({ decision: postgresId, kind: "used" }),
		);
	});

	test("nothing under .cortex/decisions/ is ever rewritten", async () => {
		const before = decisionFiles();

		await callTool(client, "search", { terms: ["jwt", "migrations"] });
		await callTool(client, "get_impact", { decision_id: postgresId });

		expect(decisionFiles()).toEqual(before);
	});

	test("the sidecar is local: git sees nothing new to version", () => {
		const status = Bun.spawnSync(["git", "status", "--porcelain"], {
			cwd: dir,
		});

		expect(status.stdout.toString()).not.toContain("local");
	});
});
