import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER_PATH = new URL("../../src/mcp/server.ts", import.meta.url)
	.pathname;

let dir: string;
let client: Client;

function run(...command: string[]): void {
	const result = Bun.spawnSync(command, { cwd: dir, stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
	}
}

async function callTool(name: string, args: Record<string, unknown>) {
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

beforeAll(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-mcp-")));
	run("git", "init", "-b", "main");
	run("git", "remote", "add", "origin", "git@github.com:acme/demo.git");
	mkdirSync(join(dir, "src/auth"), { recursive: true });
	writeFileSync(join(dir, "src/auth/service.ts"), "export const ok = 1;\n");
	run("git", "add", ".");
	run(
		"git",
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test",
		"commit",
		"-m",
		"init",
		"--no-gpg-sign",
	);

	client = new Client({ name: "e2e", version: "0.0.0" });
	await client.connect(
		new StdioClientTransport({
			command: "bun",
			args: [SERVER_PATH],
			cwd: dir,
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
		}),
	);
}, 30_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("cortex MCP server e2e", () => {
	let decisionA: string;
	let decisionB: string;

	test("exposes the four tools", async () => {
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"get_context",
			"get_impact",
			"save_decision",
			"search",
		]);
	});

	test("save_decision returns id, records head and warns on missing anchors", async () => {
		const { isError, payload } = await callTool("save_decision", {
			title: "Adotar JWT para autenticação",
			body: "Tokens de acesso de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: "auth",
			anchors: [
				{ file_path: "src/auth/service.ts", symbol: "AuthService.login" },
				{ file_path: "src/auth/missing.ts" },
			],
		});

		expect(isError).toBe(false);
		expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(payload.warnings).toEqual([
			"anchor file not found in working tree: src/auth/missing.ts",
		]);
		decisionA = payload.id;
	});

	test("save_decision rejects input violating the schema", async () => {
		const { isError } = await callTool("save_decision", {
			title: "curto",
			body: "curto demais",
			keywords: ["a", "b"],
		});
		expect(isError).toBe(true);
	});

	// Embeddings are disabled in this e2e, so the intent must share a literal
	// term with the decision — the semantic phrasing case is covered by the
	// gated SemanticSearch model test.
	test("get_context finds the saved decision by intent", async () => {
		const { payload } = await callTool("get_context", {
			intent: "onde guardamos os tokens jwt?",
		});
		const ids = payload.decisions.map(
			(decision: { id: string }) => decision.id,
		);
		expect(ids).toContain(decisionA);
		expect(payload.decisions[0].source).toBe("fts");
	});

	test("get_impact walks the DEPENDS_ON chain", async () => {
		const save = await callTool("save_decision", {
			title: "Refresh tokens em cookie httpOnly",
			body: "Refresh tokens rotacionados a cada uso ficam em cookie httpOnly.",
			keywords: ["refresh", "token", "cookie", "sessão", "security"],
			module: "auth",
			depends_on: [decisionA],
		});
		decisionB = save.payload.id;

		const { payload } = await callTool("get_impact", {
			decision_id: decisionA,
		});
		expect(payload.decision.anchors).toEqual([
			{ filePath: "src/auth/missing.ts", symbol: "" },
			{ filePath: "src/auth/service.ts", symbol: "AuthService.login" },
		]);
		expect(payload.impacted).toEqual([
			{
				id: decisionB,
				depth: 1,
				title: "Refresh tokens em cookie httpOnly",
				status: "active",
				anchors: [],
			},
		]);
	});

	test("get_impact on an unknown id errors without crashing", async () => {
		const { isError } = await callTool("get_impact", {
			decision_id: "01890000-0000-7000-8000-000000000000",
		});
		expect(isError).toBe(true);
	});

	test("replace hides the old decision from get_context", async () => {
		const replace = await callTool("save_decision", {
			title: "Migrar de JWT para sessões opacas",
			body: "Sessões opacas com introspecção substituem os JWTs por segurança.",
			keywords: ["sessão", "session", "opaque", "jwt", "migração"],
			module: "auth",
			replaces: decisionA,
		});
		expect(replace.isError).toBe(false);

		const { payload } = await callTool("get_context", {});
		const ids = payload.decisions.map(
			(decision: { id: string }) => decision.id,
		);
		expect(ids).toContain(replace.payload.id);
		expect(ids).toContain(decisionB);
		expect(ids).not.toContain(decisionA);
	});

	test("search exact matches accent-insensitively and only active decisions", async () => {
		const { payload } = await callTool("search", {
			terms: ["sessoes", "opacas"],
			exact: true,
		});
		const titles = payload.results.map(
			(result: { title: string }) => result.title,
		);
		expect(titles).toContain("Migrar de JWT para sessões opacas");
		expect(
			payload.results.every((r: { source: string }) => r.source === "fts"),
		).toBe(true);
	});
});
