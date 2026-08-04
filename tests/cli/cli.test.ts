import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { seedDecision } from "@tests/support/seed";
import { DecisionStore } from "@/decisions/decision-store";
import { probeDaemon } from "@/embedding/daemon/client";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { GEMMA_MODEL } from "@/embedding/model";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { openCodeRepository } from "@/storage/code-db";
import { openDecisionsDb } from "@/storage/connection";
import { CODE_SCHEMA_VERSION, SCHEMA_VERSION } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { CORTEX_VERSION } from "@/version";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const FAKE_WORKER_PATH = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

let dir: string;
let fakeHome: string;
let decisionA: string;

// HOME points at an empty directory so the developer's real agent configs
// (~/.claude, ~/.codex, ...) cannot leak into init's harness detection.
function cli(...args: string[]): {
	code: number;
	stdout: string;
	stderr: string;
} {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: fakeHome },
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
	fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-")));
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
	rmSync(fakeHome, { recursive: true, force: true });
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
	decisionA = seedDecision(
		join(dir, ".cortex"),
		db,
		{
			title: "Adotar JWT para autenticação",
			body: "Tokens de acesso de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: "auth",
			anchors: [{ file_path: "src/auth/service.ts" }],
		},
		context,
	).id;
	seedDecision(
		join(dir, ".cortex"),
		db,
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

function seedLoginDecision(): void {
	const db: Database = openDecisionsDb(join(dir, ".cortex"));
	const nodes = new NodeRepository(db);
	const projectId = nodes.ensureProject("github.com/acme/demo");
	seedDecision(
		join(dir, ".cortex"),
		db,
		{
			title: "Decisão do endpoint de login",
			body: "O endpoint de login consome o serviço de autenticação diretamente.",
			keywords: ["login", "endpoint", "api", "auth", "serviço"],
			anchors: [{ file_path: "src/api/login.ts" }],
		},
		{
			projectId,
			sessionId: nodes.createSession(projectId),
			commitSha: "sha-3",
			commitDirty: false,
		},
	);
	db.close();
}

function seedGhostSymbolDecision(): void {
	const db: Database = openDecisionsDb(join(dir, ".cortex"));
	const nodes = new NodeRepository(db);
	const projectId = nodes.ensureProject("github.com/acme/demo");
	seedDecision(
		join(dir, ".cortex"),
		db,
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

	test("--version and -v print the package.json version", () => {
		for (const flag of ["--version", "-v"]) {
			const result = cli(flag);
			expect(result.code).toBe(0);
			expect(result.stdout.trim()).toBe(CORTEX_VERSION);
		}
	});

	test("--help and -h print usage and exit 0", () => {
		for (const flag of ["--help", "-h"]) {
			const result = cli(flag);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("usage: cortex");
			expect(result.stdout).toContain("--version");
		}
	});

	test("subcommand --help and -h print its usage and exit 0", () => {
		for (const flag of ["--help", "-h"]) {
			const result = cli("search", flag);
			expect(result.code).toBe(0);
			expect(result.stdout).toContain("usage: cortex search");
			expect(result.stdout).toContain("search decisions by meaning or keyword");
		}
	});

	test("internal commands stay out of the usage listing", () => {
		const result = cli("--help");
		for (const internal of ["prompt-hook", "embed-worker", "embed-daemon"]) {
			expect(result.stdout).not.toContain(internal);
		}
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
			schema_version: SCHEMA_VERSION,
		});
		expect(first.stdout).toContain("Skipped .gitignore change");

		const second = cli("init", "--yes");
		expect(second.code).toBe(0);
		expect(
			Bun.spawnSync(["cat", join(dir, ".gitignore")], {}).stdout.toString(),
		).toBe("/.cortex/*\n!/.cortex/config\n!/.cortex/decisions/\n");

		const third = cli("init", "--yes");
		expect(third.code).toBe(0);
		expect(
			Bun.spawnSync(["cat", join(dir, ".gitignore")], {}).stdout.toString(),
		).toBe("/.cortex/*\n!/.cortex/config\n!/.cortex/decisions/\n");

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

		const since = cli("log", "--since", "sha-1");
		expect(since.code).toBe(0);
		expect(since.stdout).toContain("Adotar JWT");
	});

	test("log --since says so when no decision was recorded at that commit", () => {
		const result = cli("log", "--since", "deadbeef");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"No decision was recorded at commit deadbeef",
		);
		expect(result.stdout).toBe("");
	});

	test("log --json prints decisions as JSON and composes with filters", () => {
		const result = cli("log", "--json");
		expect(result.code).toBe(0);
		const decisions: { title: string; keywords: string[] }[] = JSON.parse(
			result.stdout,
		);
		expect(decisions.map((decision) => decision.title)).toContain(
			"Adotar JWT para autenticação",
		);
		expect(decisions[0]?.keywords.length).toBeGreaterThan(0);

		const filtered: { title: string }[] = JSON.parse(
			cli("log", "--module", "auth", "--json").stdout,
		);
		expect(filtered).toHaveLength(1);
		expect(filtered[0]?.title).toBe("Adotar JWT para autenticação");
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

	test("search --json prints scored results as JSON", () => {
		const result = cli("search", "jwt", "--json");
		expect(result.code).toBe(0);
		const results: {
			score: number;
			source: string;
			node: { title: string };
		}[] = JSON.parse(result.stdout);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]?.source).toBe("fts");
		expect(typeof results[0]?.score).toBe("number");
		expect(results[0]?.node.title).toBe("Adotar JWT para autenticação");
	});

	test("sync reports nothing to do, then follows a file leaving and returning", () => {
		const store = DecisionStore.at(join(dir, ".cortex"));
		expect(cli("sync").stdout).toContain("Already in sync");

		const parsed = store.read(decisionA);
		if (!parsed.ok) throw new Error(parsed.reason);
		unlinkSync(store.pathFor(decisionA));
		const gone = cli("sync", "--json");
		expect(gone.code).toBe(0);
		expect(JSON.parse(gone.stdout).absent).toEqual([decisionA]);
		expect(cli("log").stdout).not.toContain("Adotar JWT para autenticação");

		store.write(parsed.file);
		const back = cli("sync");
		expect(back.code).toBe(0);
		expect(back.stdout).toContain("1 decision(s) back on this branch");
		expect(cli("log").stdout).toContain("Adotar JWT para autenticação");
	});

	test("sync reports a link it had to drop without failing", () => {
		const store = DecisionStore.at(join(dir, ".cortex"));
		const orphanId = "019f0000-0000-7000-8000-0000000000ff";
		store.write({
			id: orphanId,
			title: "Decisão que depende de outra branch",
			body: "Depende de uma decisão que só existe em outro branch.",
			keywords: ["dangling", "branch", "link", "orfão", "edge"],
			module: null,
			replaces: null,
			dependsOn: ["019f0000-0000-7000-8000-0000000000aa"],
			anchors: [],
			commitSha: null,
			commitDirty: false,
			provenance: "agent",
			createdAt: "2026-07-22T14:03:11.204Z",
		});

		const result = cli("sync");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("link dropped, target unknown: DEPENDS_ON");
		unlinkSync(store.pathFor(orphanId));
		cli("sync");
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

	test("impact prints the indented dependency tree", () => {
		const result = cli("impact", decisionA);
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Adotar JWT para autenticação");
		expect(result.stdout).toContain("  └─ Refresh tokens em cookie httpOnly");

		const missing = cli("impact", "01890000-0000-7000-8000-000000000000");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("decision not found");
	});

	test("impact validates --depth and still accepts explicit integers", () => {
		for (const bad of ["banana", "-1", "1.5"]) {
			const result = cli("impact", decisionA, `--depth=${bad}`);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("non-negative integer");
		}

		const explicit = cli("impact", decisionA, "--depth", "1");
		expect(explicit.code).toBe(0);
		expect(explicit.stdout).toContain("Refresh tokens em cookie httpOnly");
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
		expect(result.stdout).toContain("decision files: all readable");
	});

	test("doctor names off-branch decisions, dropped links and unreadable files", () => {
		const store = DecisionStore.at(join(dir, ".cortex"));
		const parsed = store.read(decisionA);
		if (!parsed.ok) throw new Error(parsed.reason);
		const orphanId = "019f0000-0000-7000-8000-0000000000fe";
		const twinId = "019f0000-0000-7000-8000-0000000000fd";
		store.write({
			...parsed.file,
			id: orphanId,
			title: "Decisão que aponta para outro branch",
			dependsOn: ["019f0000-0000-7000-8000-0000000000aa"],
		});
		store.write({
			...parsed.file,
			id: twinId,
			title: "Primeira substituta da decisão de JWT",
			replaces: decisionA,
		});
		cli("sync");
		unlinkSync(store.pathFor(twinId));
		writeFileSync(join(store.directory, "rascunho.md"), "sem frontmatter\n");

		const result = cli("doctor");

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("decision(s) live on another branch");
		expect(result.stdout).toContain("Primeira substituta da decisão de JWT");
		expect(result.stdout).toContain("DEPENDS_ON link dropped");
		expect(result.stdout).toContain("decision file unreadable: rascunho.md");

		unlinkSync(join(store.directory, "rascunho.md"));
		unlinkSync(store.pathFor(orphanId));
		store.write(parsed.file);
		cli("sync");
	});

	test("doctor reports a decision superseded from two branches at once", () => {
		const store = DecisionStore.at(join(dir, ".cortex"));
		const parsed = store.read(decisionA);
		if (!parsed.ok) throw new Error(parsed.reason);
		const ids = [
			"019f0000-0000-7000-8000-0000000000f1",
			"019f0000-0000-7000-8000-0000000000f2",
		];
		for (const id of ids) {
			store.write({ ...parsed.file, id, replaces: decisionA });
		}

		const result = cli("doctor");

		expect(result.stdout).toContain(`superseded 2 times: ${decisionA}`);
		for (const id of ids) unlinkSync(store.pathFor(id));
		cli("sync");
	});

	test("doctor --json reports structured checks and keeps the exit code", () => {
		const result = cli("doctor", "--json");
		expect(result.code).toBe(1);
		const report: {
			checks: { level: string; message: string }[];
			issues: number;
		} = JSON.parse(result.stdout);
		expect(report.issues).toBeGreaterThan(0);
		expect(
			report.checks.some(
				(check) =>
					check.level === "warn" && check.message.includes("without embedding"),
			),
		).toBe(true);
		expect(report.checks.some((check) => check.level === "ok")).toBe(true);
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

	test("doctor shows the code.db version pair and flags a stale stamp", () => {
		expect(cli("index").code).toBe(0);
		const healthy = cli("doctor");
		expect(healthy.stdout).toContain(
			`code index: schema v${CODE_SCHEMA_VERSION}, extraction v${EXTRACTION_VERSION}`,
		);

		const { database, repository } = openCodeRepository(join(dir, ".cortex"));
		repository.stampExtractionVersion(EXTRACTION_VERSION - 1);
		database.close();

		const stale = cli("doctor");
		expect(stale.stdout).toContain(
			`code index extraction v${EXTRACTION_VERSION - 1} != current ` +
				`v${EXTRACTION_VERSION} — stale content, run: cortex index`,
		);

		expect(cli("index").stdout).toContain("(full)");
	});

	test("impact shows decisions reached through code imports", () => {
		mkdirSync(join(dir, "src/api"), { recursive: true });
		writeFileSync(
			join(dir, "src/api/login.ts"),
			'import { ok } from "../auth/service";\nexport const login = () => ok();\n',
		);
		seedLoginDecision();

		const result = cli("impact", decisionA);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Via code (imports):");
		expect(result.stdout).toContain("src/api/login.ts (1 hop, heuristic)");
		expect(result.stdout).toContain("Decisão do endpoint de login");
	});

	test("impact --json serializes root, graph and code impact", () => {
		const result = cli("impact", decisionA, "--json");
		expect(result.code).toBe(0);
		const impact: {
			root: { id: string };
			impacted: { node: { title: string } }[];
			codeImpacted: { filePath: string }[];
			codeWarning: string | null;
		} = JSON.parse(result.stdout);
		expect(impact.root.id).toBe(decisionA);
		expect(impact.impacted.map((entry) => entry.node.title)).toContain(
			"Refresh tokens em cookie httpOnly",
		);
		expect(impact.codeImpacted.map((entry) => entry.filePath)).toContain(
			"src/api/login.ts",
		);
		expect(impact.codeWarning).toBeNull();
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

	test("why --json distinguishes path, symbol and no-match targets", () => {
		const byPath = JSON.parse(
			cli("why", "src/auth/service.ts", "--json").stdout,
		);
		expect(byPath.matchedBy).toBe("path");
		expect(
			byPath.decisions.map((decision: { title: string }) => decision.title),
		).toContain("Adotar JWT para autenticação");

		const bySymbol = JSON.parse(cli("why", "ok", "--json").stdout);
		expect(bySymbol.matchedBy).toBe("symbol");
		expect(bySymbol.locations[0].filePath).toBe("src/auth/service.ts");
		expect(bySymbol.locations[0].line).toBe(2);

		const none = JSON.parse(cli("why", "GhostSymbol", "--json").stdout);
		expect(none.matchedBy).toBeNull();
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
			expect(client.getServerVersion()?.version).toBe(CORTEX_VERSION);
		} finally {
			await client.close();
		}
	}, 30_000);
});

describe("cortex prompt-hook", () => {
	function promptHook(
		payload: unknown,
		env: Record<string, string> = {},
	): { code: number; stdout: string; stderr: string } {
		const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
		const result = Bun.spawnSync(["bun", MAIN_PATH, "prompt-hook"], {
			cwd: dir,
			stdin: new TextEncoder().encode(raw),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", ...env },
		});
		return {
			code: result.exitCode ?? 1,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}

	test("keyword match injects decisions with title and body (high tier)", () => {
		const result = promptHook({
			prompt: "como funciona a autenticação por jwt?",
			cwd: dir,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("<cortex_context");
		expect(result.stdout).toContain("Adotar JWT para autenticação");
		expect(result.stdout).toContain("RS256");
	});

	test("title-only match injects titles and ids only (medium tier)", () => {
		const result = promptHook({
			prompt: "vale a pena adotar outra abordagem?",
			cwd: dir,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("<cortex_context");
		expect(result.stdout).toContain("Adotar JWT para autenticação");
		expect(result.stdout).toContain(decisionA);
		expect(result.stdout).not.toContain("RS256");
	});

	test("unrelated prompts inject nothing", () => {
		const result = promptHook({
			prompt: "melhora a paleta de cores do gráfico de vendas",
			cwd: dir,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("malformed payloads exit 0 in silence", () => {
		const result = promptHook("not json{{");
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("kill-switch disables injection", () => {
		const result = promptHook(
			{ prompt: "como funciona a autenticação por jwt?", cwd: dir },
			{ CORTEX_NO_PROMPT_HOOK: "1" },
		);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("a cwd without an initialized store exits 0 in silence", () => {
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "cortex-bare-")));
		try {
			const result = promptHook({ prompt: "jwt auth login", cwd: bare });
			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	test("high-tier injection truncates long bodies", () => {
		const db: Database = openDecisionsDb(join(dir, ".cortex"));
		const nodes = new NodeRepository(db);
		const projectId = nodes.ensureProject("github.com/acme/demo");
		seedDecision(
			join(dir, ".cortex"),
			db,
			{
				title: "Decisão com corpo gigante",
				body: "palavra ".repeat(700),
				keywords: ["gigante", "enorme", "huge", "payload", "corpo"],
			},
			{
				projectId,
				sessionId: nodes.createSession(projectId),
				commitSha: "sha-4",
				commitDirty: false,
			},
		);
		db.close();

		const result = promptHook({ prompt: "esse payload gigante", cwd: dir });
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Decisão com corpo gigante");
		expect(result.stdout).toContain("…");
		expect(result.stdout.length).toBeLessThan(1500);
	});
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
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: fakeHome },
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

describe("cortex CLI with an unreadable code index", () => {
	let brokenDir: string;

	beforeAll(() => {
		brokenDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-broken-")));
		mkdirSync(join(brokenDir, "src"), { recursive: true });
		writeFileSync(
			join(brokenDir, "src/service.ts"),
			"export const answer = 42;\n",
		);
		Bun.spawnSync(["bun", MAIN_PATH, "init"], {
			cwd: brokenDir,
			env: { ...process.env, HOME: fakeHome },
		});
		writeFileSync(join(brokenDir, ".cortex/code.db"), "not a sqlite database");
	});

	afterAll(() => {
		rmSync(brokenDir, { recursive: true, force: true });
	});

	function cliBroken(...args: string[]) {
		const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
			cwd: brokenDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: fakeHome },
		});
		return { code: result.exitCode ?? 1, stdout: result.stdout.toString() };
	}

	test("why reports the unavailable index instead of crashing", () => {
		const result = cliBroken("why", "answer");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("code index unavailable");
	});

	test("why --json carries the warning", () => {
		const result = cliBroken("why", "answer", "--json");
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			target: "answer",
			matchedBy: null,
			codeWarning: expect.stringContaining("code index unavailable"),
		});
	});

	test("doctor reports the unreadable index and still runs its other checks", () => {
		const result = cliBroken("doctor");
		expect(result.code).toBe(1);
		expect(result.stdout).toContain("code index unreadable");
		expect(result.stdout).toContain("run: cortex index");
		expect(result.stdout).toContain("config: model");
	});
});

describe("cortex install and agent instructions", () => {
	let projectDir: string;
	let agentHome: string;

	beforeAll(() => {
		projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-inst-")));
		agentHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-inst-")));
		for (const marker of [".claude", ".codex", ".cursor", ".gemini"]) {
			mkdirSync(join(agentHome, marker), { recursive: true });
		}
		writeFileSync(join(agentHome, ".codex/config.toml"), 'model = "gpt-5"\n');
	});

	afterAll(() => {
		rmSync(projectDir, { recursive: true, force: true });
		rmSync(agentHome, { recursive: true, force: true });
	});

	function cliAt(home: string, ...args: string[]) {
		const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: home },
		});
		return {
			code: result.exitCode ?? 1,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}

	test("install --yes registers every detected harness, then reports unchanged", () => {
		const first = cliAt(agentHome, "install", "--yes");
		expect(first.code).toBe(0);
		for (const name of ["Claude Code", "Codex CLI", "Cursor", "Gemini CLI"]) {
			expect(first.stdout).toContain(name);
		}

		for (const config of [
			".claude.json",
			".cursor/mcp.json",
			".gemini/settings.json",
		]) {
			const parsed = JSON.parse(
				Bun.spawnSync(["cat", join(agentHome, config)], {}).stdout.toString(),
			);
			expect(parsed.mcpServers.cortex.args).toEqual(["serve", "--mcp"]);
		}
		const toml = Bun.spawnSync(
			["cat", join(agentHome, ".codex/config.toml")],
			{},
		).stdout.toString();
		expect(toml).toContain('model = "gpt-5"');
		expect(toml).toContain("[mcp_servers.cortex]");
		expect(toml).toContain('args = ["serve", "--mcp"]');

		const second = cliAt(agentHome, "install", "--yes");
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("already registered");
	});

	test("non-interactive install without --yes writes nothing and fails", () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-tty-")));
		try {
			mkdirSync(join(home, ".claude"));
			const result = cliAt(home, "install");
			expect(result.code).toBe(1);
			expect(result.stdout).toContain("nothing written");
			expect(existsSync(join(home, ".claude.json"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("install with nothing detected explains itself and exits 0", () => {
		const result = cliAt(fakeHome, "install", "--yes");
		expect(result.code).toBe(0);
		expect(result.stdout).toContain("no supported coding agents detected");
	});

	test("an explicit --target wins over detection; unknown ids fail", () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-tgt-")));
		try {
			const explicit = cliAt(home, "install", "--yes", "--target", "claude");
			expect(explicit.code).toBe(0);
			expect(existsSync(join(home, ".claude.json"))).toBe(true);

			const unknown = cliAt(home, "install", "--yes", "--target", "copilot");
			expect(unknown.code).toBe(1);
			expect(unknown.stderr).toContain("unknown target: copilot");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("install fails loudly on an unreadable harness config", () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-bad-")));
		try {
			writeFileSync(join(home, ".claude.json"), "{broken");
			const result = cliAt(home, "install", "--yes", "--target", "claude");
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("is not valid JSON");
			expect(
				Bun.spawnSync(
					["cat", join(home, ".claude.json")],
					{},
				).stdout.toString(),
			).toBe("{broken");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("init --yes writes the instruction block into each harness file", () => {
		writeFileSync(join(projectDir, "CLAUDE.md"), "# My rules\n");
		const first = cliAt(agentHome, "init", "--yes");
		expect(first.code).toBe(0);

		const claudeMd = Bun.spawnSync(
			["cat", join(projectDir, "CLAUDE.md")],
			{},
		).stdout.toString();
		expect(claudeMd).toContain("# My rules");
		expect(claudeMd).toContain("<!-- cortex:begin -->");
		expect(claudeMd).toContain("save_decision");
		for (const name of ["AGENTS.md", "GEMINI.md"]) {
			expect(existsSync(join(projectDir, name))).toBe(true);
		}

		const second = cliAt(agentHome, "init", "--yes");
		expect(second.code).toBe(0);
		expect(second.stdout).toContain("cortex instructions unchanged");
		expect(
			Bun.spawnSync(
				["cat", join(projectDir, "CLAUDE.md")],
				{},
			).stdout.toString(),
		).toBe(claudeMd);
	});

	test("init without agents hints at cortex install instead of writing files", () => {
		const bare = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cli-bare-")));
		try {
			const result = Bun.spawnSync(["bun", MAIN_PATH, "init", "--yes"], {
				cwd: bare,
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, CORTEX_DISABLE_EMBEDDINGS: "1", HOME: fakeHome },
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("No coding agents detected");
			expect(existsSync(join(bare, "CLAUDE.md"))).toBe(false);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});

describe("internal embed commands", () => {
	test("embed-worker exits cleanly on end of input without loading a model", () => {
		const result = Bun.spawnSync(["bun", MAIN_PATH, "embed-worker"], {
			stdin: new Uint8Array(0),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toBe("");
	});

	test("embed-daemon serves the worker protocol through the CLI", async () => {
		const daemonDir = realpathSync(
			mkdtempSync(join(tmpdir(), "cortex-cli-daemon-")),
		);
		const paths = daemonPathsFor(GEMMA_MODEL.modelId, daemonDir);
		const child = Bun.spawn(
			["bun", MAIN_PATH, "embed-daemon", GEMMA_MODEL.modelId],
			{
				stdout: "ignore",
				stderr: "pipe",
				env: {
					...process.env,
					CORTEX_DAEMON_DIR: daemonDir,
					CORTEX_EMBED_WORKER_PATH: FAKE_WORKER_PATH,
				},
			},
		);
		try {
			const connection = await connectedDaemon(paths);
			expect(connection.hello.modelId).toBe(GEMMA_MODEL.modelId);
			expect(connection.hello.cortex).toBe(CORTEX_VERSION);
			expect(await connection.embed("query", ["hello"])).toEqual([[5, 0, 1]]);
			connection.close();
		} finally {
			child.kill("SIGTERM");
			await child.exited;
			rmSync(daemonDir, { recursive: true, force: true });
		}
	}, 15_000);

	async function connectedDaemon(paths: DaemonPaths) {
		const endpoint = {
			paths,
			version: CORTEX_VERSION,
			modelId: GEMMA_MODEL.modelId,
		};
		for (let attempt = 0; attempt < 80; attempt++) {
			const probe = await probeDaemon(endpoint);
			if (probe.status === "connected") return probe.connection;
			await Bun.sleep(50);
		}
		throw new Error("daemon did not come up");
	}
});
