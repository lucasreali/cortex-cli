import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connect, makeProject } from "./harness";

let dir: string;
let client: Client;
let decisionId: string;

beforeAll(async () => {
	dir = makeProject("cortex-broken-index-", "git@github.com:acme/broken.git");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/service.ts"), "export const answer = 42;\n");
	writeFileSync(join(dir, ".cortex/code.db"), "not a sqlite database");
	client = await connect(dir);

	const save = await callTool(client, "save_decision", {
		title: "Serviço central concentra a lógica de resposta",
		body: "O módulo service concentra a lógica de resposta padrão do sistema.",
		keywords: ["service", "serviço", "core", "resposta", "answer"],
		anchors: [{ file_path: "src/service.ts" }],
	});
	decisionId = save.payload.id;
}, 30_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("MCP result discipline with an unavailable code index", () => {
	test("get_impact answers with code_warning, not isError", async () => {
		const { isError, payload } = await callTool(client, "get_impact", {
			decision_id: decisionId,
		});
		expect(isError).toBe(false);
		expect(payload.code_impacted).toEqual([]);
		expect(payload.code_warning).toContain("code index unavailable");
	});

	test("save_decision with a symbol anchor degrades to a warning", async () => {
		const { isError, payload } = await callTool(client, "save_decision", {
			title: "Símbolo ancorado com índice quebrado",
			body: "Valida que a indisponibilidade do índice vira warning e não erro.",
			keywords: ["índice", "index", "warning", "symbol", "anchor"],
			anchors: [{ file_path: "src/service.ts", symbol: "answer" }],
		});
		expect(isError).toBe(false);
		expect(payload.warnings.join(" ")).toContain("code index unavailable");
	});
});
