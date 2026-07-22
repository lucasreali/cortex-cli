import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
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
import { openDecisionsDb } from "@/storage/connection";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;

let dir: string;
let decisionA: string;

function cli(...args: string[]): {
	code: number;
	stdout: string;
	stderr: string;
} {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
	});
	return {
		code: result.exitCode ?? 1,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", ...args], { cwd: dir, stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-")));
	git("init", "-b", "main");
	git("remote", "add", "origin", "git@github.com:acme/demo.git");
	mkdirSync(join(dir, "src/auth"), { recursive: true });
	writeFileSync(join(dir, "src/auth/service.ts"), "export const ok = 1;\n");
	git("add", ".");
	git(
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test",
		"commit",
		"-m",
		"init",
		"--no-gpg-sign",
	);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function seedDecisions(): void {
	const db: Database = openDecisionsDb(join(dir, ".cortex"));
	const nodes = new NodeRepository(db);
	const projectId = nodes.ensureProject("github.com/acme/demo");
	const sessionId = nodes.createSession(projectId);
	const context: SaveContext = {
		projectId,
		sessionId,
		commitSha: "sha-1",
		commitDirty: false,
	};
	decisionA = nodes.createDecision(
		{
			title: "Adotar JWT para autenticação",
			body: "Tokens de acesso de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: "auth",
			anchors: [{ file_path: "src/auth/service.ts" }],
		},
		context,
	).id;
	nodes.createDecision(
		{
			title: "Refresh tokens em cookie httpOnly",
			body: "Refresh tokens rotacionados a cada uso ficam em cookie httpOnly.",
			keywords: ["refresh", "token", "cookie", "sessão", "security"],
			module: "billing",
			depends_on: [decisionA],
		},
		context,
	);
	db.close();
}

function seedGhostSymbolDecision(): void {
	const db: Database = openDecisionsDb(join(dir, ".cortex"));
	const nodes = new NodeRepository(db);
	const projectId = nodes.ensureProject("github.com/acme/demo");
	nodes.createDecision(
		{
			title: "Decisão ancorada num símbolo que não existe",
			body: "Âncora aponta para Ghost.method, removido do código há tempos.",
			keywords: ["ghost", "símbolo", "symbol", "órfão", "orphan"],
			anchors: [{ file_path: "src/auth/service.ts", symbol: "Ghost.method" }],
		},
		{
			projectId,
			sessionId: nodes.createSession(projectId),
			commitSha: "sha-2",
			commitDirty: false,
		},
	);
	db.close();
}

describe("cortex CLI", () => {
	test("unknown command prints usage and fails", () => {
		const result = cli("nonsense");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("usage: cortex");
	});

	test("commands require init first", () => {
		for (const command of ["log", "index"]) {
			const result = cli(command);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("cortex init");
		}
	});

	test("init creates .cortex, config and prints next steps — idempotently", () => {
		const first = cli("init");
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("Next steps");
		expect(existsSync(join(dir, ".cortex/decisions.db"))).toBe(true);
		expect(
			JSON.parse(
				Bun.spawnSync(
					["cat", join(dir, ".cortex/config")],
					{},
				).stdout.toString(),
			),
		).toEqual({
			model_id: "embeddinggemma-300m-q8@256",
			schema_version: 1,
		});
		expect(first.stdout).toContain("Skipped .gitignore change");

		const second = cli("init", "--yes");
		expect(second.code).toBe(0);
		expect(
			Bun.spawnSync(["cat", join(dir, ".gitignore")], {}).stdout.toString(),
		).toContain(".cortex/code.db*");

		seedDecisions();
	});

	test("log lists active decisions and filters by module", () => {
		const all = cli("log");
		expect(all.code).toBe(0);
		expect(all.stdout).toContain("Adotar JWT para autenticação");
		expect(all.stdout).toContain("[billing] Refresh tokens em cookie httpOnly");

		const filtered = cli("log", "--module", "auth");
		expect(filtered.code).toBe(0);
		expect(filtered.stdout).toContain("Adotar JWT");
		expect(filtered.stdout).not.toContain("Refresh tokens");
	});

	test("why matches file anchors and directory prefixes", () => {
		const byFile = cli("why", "src/auth/service.ts");
		expect(byFile.code).toBe(0);
		expect(byFile.stdout).toContain("Adotar JWT para autenticação");

		const byDirectory = cli("why", "src/auth");
		expect(byDirectory.code).toBe(0);
		expect(byDirectory.stdout).toContain("Adotar JWT para autenticação");

		const nothing = cli("why", "src/api");
		expect(nothing.code).toBe(0);
		expect(nothing.stdout).toContain("No decisions anchored to src/api.");
	});

	test("search reports score and origin, exact and degraded semantic", () => {
		const exact = cli("search", "autenticacao", "--exact");
		expect(exact.code).toBe(0);
		expect(exact.stdout).toContain("fts");
		expect(exact.stdout).toContain("Adotar JWT para autenticação");

		const semantic = cli("search", "jwt");
		expect(semantic.code).toBe(0);
		expect(semantic.stdout).toContain("fts");
		expect(semantic.stdout).toContain("Adotar JWT para autenticação");
	});

	test("impact prints the indented dependency tree", () => {
		const result = cli("impact", decisionA);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Adotar JWT para autenticação");
		expect(result.stdout).toContain("  └─ Refresh tokens em cookie httpOnly");

		const missing = cli("impact", "01890000-0000-7000-8000-000000000000");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("decision not found");
	});

	test("index builds code.db in full, then incrementally, then forced", () => {
		const first = cli("index");
		expect(first.code).toBe(0);
		expect(first.stdout).toContain("Indexed 1 file(s) (full)");
		expect(existsSync(join(dir, ".cortex/code.db"))).toBe(true);

		const second = cli("index");
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("Indexed 0 file(s) (incremental)");
		expect(second.stdout).toContain("1 unchanged");

		const forced = cli("index", "--force");
		expect(forced.stdout).toContain("(full)");
	});

	test("embed --missing fails loudly when embeddings are disabled", () => {
		const result = cli("embed", "--missing");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("disabled");
	});

	test("embed requires exactly one mode", () => {
		const result = cli("embed");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("usage: cortex embed");
	});

	test("doctor reports pending embeddings and exits non-zero", () => {
		const result = cli("doctor");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("without embedding");
		expect(result.stdout).toContain("anchors: all files exist");
		expect(result.stdout).toContain("keywords: all decisions have >= 5");
		expect(result.stdout).toContain("code index: in sync");
	});

	test("doctor flags an outdated code index, low resolution and orphan symbols", () => {
		writeFileSync(
			join(dir, "src/auth/service.ts"),
			'import { gone } from "./missing";\nexport const ok = () => gone;\n',
		);
		expect(cli("index").code).toBe(0);
		writeFileSync(join(dir, "src/auth/extra.ts"), "export const x = 1;\n");
		seedGhostSymbolDecision();

		const result = cli("doctor");

		expect(result.stdout).toContain(
			"code index outdated: 1 new, 0 changed, 0 deleted",
		);
		expect(result.stdout).toContain("0/1 resolvable imports resolved (0.0%)");
		expect(result.stdout).toContain("below 85%");
		expect(result.stdout).toContain(
			"orphan symbol anchor: src/auth/service.ts#Ghost.method",
		);
	});

	test("why resolves a bare symbol to its file and anchored decisions", () => {
		const result = cli("why", "ok");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("ok — src/auth/service.ts:2");
		expect(result.stdout).toContain("Adotar JWT para autenticação");

		const unknown = cli("why", "GhostSymbol");
		expect(unknown.code).toBe(0);
		expect(unknown.stdout).toContain("No decisions anchored to GhostSymbol.");
	});

	test("serve requires --mcp", () => {
		const result = cli("serve");
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("usage: cortex serve --mcp");
	});

	test("serve --mcp answers an MCP client", async () => {
		const client = new Client({ name: "cli-e2e", version: "0.0.0" });
		await client.connect(
			new StdioClientTransport({
				command: "bun",
				args: [MAIN_PATH, "serve", "--mcp"],
				cwd: dir,
				env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
			}),
		);
		try {
			const tools = await client.listTools();
			expect(tools.tools).toHaveLength(4);
		} finally {
			await client.close();
		}
	}, 30_000);
});

describe("cortex CLI in an empty project", () => {
	let emptyDir: string;

	beforeAll(() => {
		emptyDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-empty-")));
	});

	afterAll(() => {
		rmSync(emptyDir, { recursive: true, force: true });
	});

	function cliEmpty(...args: string[]) {
		const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
			cwd: emptyDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1" },
		});
		return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
	}

	test("a config pinning an unknown model_id fails the startup loudly", () => {
		expect(cliEmpty("init").code).toBe(0);
		writeFileSync(
			join(emptyDir, ".cortex/config"),
			JSON.stringify({ model_id: "unknown-model@1", schema_version: 1 }),
		);
		const result = Bun.spawnSync(["bun", MAIN_PATH, "log"], {
			cwd: emptyDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: undefined },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain(
			'no embedding provider implements model_id "unknown-model@1"',
		);
		writeFileSync(
			join(emptyDir, ".cortex/config"),
			JSON.stringify({
				model_id: "embeddinggemma-300m-q8@256",
				schema_version: 1,
			}),
		);
	});

	test("init works without git and embed --missing is a clean no-op", () => {
		expect(cliEmpty("init").code).toBe(0);
		const embed = cliEmpty("embed", "--missing");
		expect(embed.code).toBe(0);
		expect(embed.stdout).toContain("Nothing to embed.");

		const log = cliEmpty("log");
		expect(log.code).toBe(0);
		expect(log.stdout).toContain("No active decisions.");

		const doctor = cliEmpty("doctor");
		expect(doctor.code).toBe(1);
		expect(doctor.stdout).toContain("code index not built — run: cortex index");
	});
});
