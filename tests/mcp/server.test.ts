import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	CLI_PATH,
	callTool as callToolOn,
	connect,
	makeTempDir,
	run as runIn,
} from "./harness";

let dir: string;
let client: Client;

function run(...command: string[]): void {
	runIn(dir, ...command);
}

async function callTool(name: string, args: Record<string, unknown>) {
	return callToolOn(client, name, args);
}

beforeAll(async () => {
	dir = makeTempDir("cortex-mcp-");
	run("git", "init", "-b", "main");
	run("git", "remote", "add", "origin", "git@github.com:acme/demo.git");
	mkdirSync(join(dir, "src/auth"), { recursive: true });
	mkdirSync(join(dir, "src/api"), { recursive: true });
	writeFileSync(
		join(dir, "src/auth/service.ts"),
		"export class AuthService {\n\tvalidateToken(token: string) {\n\t\treturn token.length > 0;\n\t}\n}\n",
	);
	writeFileSync(
		join(dir, "src/api/login.ts"),
		'import { AuthService } from "../auth/service";\nexport const login = () => new AuthService();\n',
	);
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
	run("bun", CLI_PATH, "init", "--yes");

	client = await connect(dir);
}, 30_000);

afterAll(async () => {
	await client?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("cortex MCP server e2e", () => {
	let decisionA: string;
	let decisionB: string;

	test("exposes the six tools", async () => {
		const tools = await client.listTools();
		expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
			"get_context",
			"get_impact",
			"save_decision",
			"save_session_summary",
			"search",
			"search_all_projects",
		]);
	});

	test("read tools advertise the read-only contract", async () => {
		const tools = await client.listTools();
		const annotations = new Map(
			tools.tools.map((tool) => [tool.name, tool.annotations]),
		);
		for (const name of [
			"get_context",
			"get_impact",
			"search",
			"search_all_projects",
		]) {
			expect(annotations.get(name)?.readOnlyHint).toBe(true);
			expect(annotations.get(name)?.destructiveHint).toBe(false);
		}
		expect(annotations.get("save_decision")?.readOnlyHint).toBeUndefined();
		expect(
			annotations.get("save_session_summary")?.readOnlyHint,
		).toBeUndefined();
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
			"symbol not found in code index: AuthService.login (src/auth/service.ts)" +
				" — did you mean: AuthService.validateToken?",
		]);
		expect(payload.conflict_candidates).toEqual([]);
		decisionA = payload.id;
	});

	test("save_decision accepts a valid symbol anchor without warnings", async () => {
		const { isError, payload } = await callTool("save_decision", {
			title: "Validação de token centralizada no AuthService",
			body: "Toda validação de token passa pelo método validateToken do serviço.",
			keywords: ["token", "validação", "validation", "auth", "service"],
			module: "auth",
			anchors: [
				{
					file_path: "src/auth/service.ts",
					symbol: "AuthService.validateToken",
				},
			],
		});
		expect(isError).toBe(false);
		expect(payload.warnings).toEqual([]);
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

	test("get_impact reaches decisions through code imports, with provenance", async () => {
		const save = await callTool("save_decision", {
			title: "Endpoint de login usa o AuthService diretamente",
			body: "O handler de login instancia o AuthService sem camada intermediária.",
			keywords: ["login", "endpoint", "handler", "auth", "api"],
			module: "api",
			anchors: [{ file_path: "src/api/login.ts" }],
		});
		const loginDecision = save.payload.id;

		const { payload } = await callTool("get_impact", {
			decision_id: decisionA,
		});

		expect(payload.code_impacted).toEqual([
			{
				id: loginDecision,
				title: "Endpoint de login usa o AuthService diretamente",
				status: "active",
				file: "src/api/login.ts",
				depth: 1,
				provenance: "heuristic",
			},
		]);
		const dependsOnIds = payload.impacted.map(
			(entry: { id: string }) => entry.id,
		);
		expect(dependsOnIds).not.toContain(loginDecision);

		const anchorless = await callTool("get_impact", { decision_id: decisionB });
		expect(anchorless.payload.code_impacted).toEqual([]);
	});

	test("get_impact on an unknown id returns guidance, not an error", async () => {
		const { isError, payload } = await callTool("get_impact", {
			decision_id: "01890000-0000-7000-8000-000000000000",
		});
		expect(isError).toBe(false);
		expect(payload.status).toBe("not_found");
		expect(payload.guidance).toContain("get_context");
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

	test("get_context without intent exposes project identity and modules", async () => {
		const { payload } = await callTool("get_context", {});
		expect(payload.project).toBe("github.com/acme/demo");
		expect(payload.modules).toEqual(["api", "auth"]);
	});

	test("save_session_summary surfaces the narrative in the overview", async () => {
		const summary =
			"Implemented: fluxo de autenticação JWT.\n" +
			"Decisions: tokens RS256 de curta duração.\n" +
			"Open: rotação de refresh tokens pendente.";
		const { isError, payload } = await callTool("save_session_summary", {
			summary,
		});
		expect(isError).toBe(false);
		expect(payload.session_id).toMatch(/^[0-9a-f-]{36}$/);

		const context = await callTool("get_context", {});
		expect(context.payload.sessions).toContainEqual({
			id: payload.session_id,
			summary,
			createdAt: expect.any(String),
		});
	});

	test("save_session_summary replaces the previous narrative", async () => {
		const first = await callTool("save_session_summary", {
			summary: "Implemented: nada ainda. Decisions: nenhuma. Open: tudo.",
		});
		const rewritten =
			"Implemented: sessão concluída. Decisions: registradas. Open: nada.";
		const second = await callTool("save_session_summary", {
			summary: rewritten,
		});
		expect(second.payload.session_id).toBe(first.payload.session_id);

		const context = await callTool("get_context", {});
		const entries = context.payload.sessions.filter(
			(session: { id: string }) => session.id === first.payload.session_id,
		);
		expect(entries).toEqual([
			{
				id: first.payload.session_id,
				summary: rewritten,
				createdAt: expect.any(String),
			},
		]);
	});

	test("save_session_summary rejects a summary below the minimum length", async () => {
		const { isError } = await callTool("save_session_summary", {
			summary: "curto demais",
		});
		expect(isError).toBe(true);
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

	test("save_decision with unknown linked ids returns guidance, not an error", async () => {
		const ghost = "01890000-0000-7000-8000-00000000dead";
		const { isError, payload } = await callTool("save_decision", {
			title: "Tentativa de link inválido",
			body: "Corpo suficiente para o schema de decisão aceitar este registro.",
			keywords: ["link", "inválido", "invalid", "teste", "guidance"],
			depends_on: [ghost],
		});
		expect(isError).toBe(false);
		expect(payload.status).toBe("not_found");
		expect(payload.guidance).toContain(ghost);

		const lookup = await callTool("search", {
			terms: ["inválido"],
			exact: true,
		});
		expect(lookup.payload.results).toEqual([]);
	});

	test("save_decision flags a near-duplicate as a conflict candidate", async () => {
		const { isError, payload } = await callTool("save_decision", {
			title: "Refresh tokens guardados no localStorage",
			body: "Refresh tokens persistidos no localStorage para sobreviver reloads.",
			keywords: ["refresh", "token", "cookie", "sessão", "web"],
			module: "auth",
		});

		expect(isError).toBe(false);
		const candidate = payload.conflict_candidates.find(
			(entry: { id: string }) => entry.id === decisionB,
		);
		expect(candidate).toMatchObject({
			id: decisionB,
			title: "Refresh tokens em cookie httpOnly",
			module: "auth",
		});
		expect(candidate.reason).toContain("shares keywords");
	});

	test("conflicts_with surfaces on both partners in get_context", async () => {
		const save = await callTool("save_decision", {
			title: "Rotação de refresh tokens no servidor",
			body: "O servidor rotaciona refresh tokens, contradizendo o armazenamento em cookie.",
			keywords: ["refresh", "rotação", "rotation", "server", "token"],
			module: "auth",
			conflicts_with: [decisionB],
		});
		expect(save.isError).toBe(false);

		const { payload } = await callTool("get_context", {});
		const byId = new Map(
			payload.decisions.map((decision: { id: string }) => [
				decision.id,
				decision,
			]),
		);
		expect(byId.get(save.payload.id)).toMatchObject({
			conflicts_with: [decisionB],
		});
		expect(byId.get(decisionB)).toMatchObject({
			conflicts_with: [save.payload.id],
		});
	});

	test("archiving retires a decision without a successor", async () => {
		const doomed = await callTool("save_decision", {
			title: "Cache de sessões no módulo removido",
			body: "O módulo legacy-cache guardava sessões em memória local do processo.",
			keywords: ["cache", "sessão", "legacy", "memória", "memory"],
			module: "legacy",
		});
		const archive = await callTool("save_decision", {
			title: "Módulo legacy-cache removido do produto",
			body: "O módulo foi excluído; a decisão sobre seu cache não se aplica mais.",
			keywords: ["legacy", "removido", "removed", "cache", "cleanup"],
			module: "legacy",
			archives: doomed.payload.id,
		});
		expect(archive.isError).toBe(false);

		const context = await callTool("get_context", {});
		const ids = context.payload.decisions.map(
			(decision: { id: string }) => decision.id,
		);
		expect(ids).not.toContain(doomed.payload.id);
		expect(ids).toContain(archive.payload.id);

		const lookup = await callTool("search", {
			terms: ["memória"],
			exact: true,
		});
		expect(
			lookup.payload.results.map((result: { id: string }) => result.id),
		).not.toContain(doomed.payload.id);

		const impact = await callTool("get_impact", {
			decision_id: doomed.payload.id,
		});
		expect(impact.payload.decision.status).toBe("archived");
	});

	test("save_decision with an unknown archives id returns guidance", async () => {
		const ghost = "01890000-0000-7000-8000-00000000cafe";
		const { isError, payload } = await callTool("save_decision", {
			title: "Arquivamento de decisão fantasma",
			body: "Corpo suficiente para o schema de decisão aceitar este registro.",
			keywords: ["arquivo", "archive", "ghost", "teste", "guidance"],
			archives: ghost,
		});
		expect(isError).toBe(false);
		expect(payload.status).toBe("not_found");
		expect(payload.guidance).toContain(ghost);
	});

	test("save_decision with an unknown conflicts_with id returns guidance", async () => {
		const ghost = "01890000-0000-7000-8000-00000000beef";
		const { isError, payload } = await callTool("save_decision", {
			title: "Conflito com decisão fantasma",
			body: "Corpo suficiente para o schema de decisão aceitar este registro.",
			keywords: ["conflito", "conflict", "ghost", "teste", "guidance"],
			conflicts_with: [ghost],
		});
		expect(isError).toBe(false);
		expect(payload.status).toBe("not_found");
		expect(payload.guidance).toContain(ghost);
	});

	test("search with unmatched terms returns empty results with guidance", async () => {
		const { isError, payload } = await callTool("search", {
			terms: ["kubernetes"],
			exact: true,
		});
		expect(isError).toBe(false);
		expect(payload.results).toEqual([]);
		expect(payload.guidance).toContain("get_context");
	});

	test("get_context with an unmatched intent returns guidance", async () => {
		const { isError, payload } = await callTool("get_context", {
			intent: "observability opentelemetry tracing",
		});
		expect(isError).toBe(false);
		expect(payload.decisions).toEqual([]);
		expect(payload.guidance).toContain("search");
	});
});
