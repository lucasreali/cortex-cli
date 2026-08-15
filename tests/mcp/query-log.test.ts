import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { decodeEntries, type QueryLogEntry } from "@/querylog/entry";
import { ENABLE_VARIABLE } from "@/querylog/settings";
import { CLI_PATH, callTool, connect, makeTempDir, run } from "./harness";

const decision = {
	title: "Adotar JWT para login",
	body: "Tokens de acesso assinados com RS256, refresh rotacionado em cookie.",
	keywords: ["jwt", "login", "token", "autenticação", "segurança"],
};

let dir: string;
let quiet: Client;
let recording: Client;

function logPath(): string {
	return join(dir, ".cortex", "local", "queries.jsonl");
}

function recorded(): QueryLogEntry[] {
	if (!existsSync(logPath())) return [];
	return decodeEntries(readFileSync(logPath(), "utf8"));
}

beforeAll(async () => {
	dir = makeTempDir("cortex-querylog-mcp-");
	run(dir, "git", "init", "-b", "main");
	run(dir, "git", "remote", "add", "origin", "git@github.com:acme/demo.git");
	run(dir, "bun", CLI_PATH, "init", "--yes");
	quiet = await connect(dir);
	await callTool(quiet, "save_decision", decision);
}, 30_000);

afterAll(async () => {
	await quiet?.close();
	await recording?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("the query log over the real MCP surface", () => {
	test("nothing is recorded without the opt-in", async () => {
		await callTool(quiet, "get_context", { intent: "como fazemos login?" });
		await callTool(quiet, "search", { terms: ["jwt"] });

		expect(recorded()).toEqual([]);
	});

	test("an opted-in session records the intent and the terms", async () => {
		recording = await connect(dir, { [ENABLE_VARIABLE]: "1" });

		await callTool(recording, "get_context", {
			intent: "como fazemos login?",
			module: "auth",
		});
		await callTool(recording, "search", { terms: ["jwt", "login"] });

		expect(recorded()).toMatchObject([
			{
				surface: "get_context",
				query: "como fazemos login?",
				module: "auth",
			},
			{ surface: "search", query: "jwt login", terms: ["jwt", "login"] },
		]);
	});

	test("the overview path of get_context records nothing", async () => {
		const before = recorded().length;

		await callTool(recording, "get_context", {});

		expect(recorded()).toHaveLength(before);
	});

	test("a cross-project sweep is not this project's traffic", async () => {
		const before = recorded().length;

		await callTool(recording, "search_all_projects", { terms: ["jwt"] });

		expect(recorded()).toHaveLength(before);
	});

	test("every query is one line, and one session labels them all", async () => {
		await callTool(recording, "search", { terms: ["jwt"] });
		await callTool(recording, "search", { terms: ["jwt"] });
		const sessions = new Set(recorded().map((entry) => entry.session));

		expect(sessions.size).toBe(1);
		expect(recorded().filter((entry) => entry.query === "jwt")).toHaveLength(2);
	});
});
