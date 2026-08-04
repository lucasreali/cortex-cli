import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DecisionSync, openDecisionSync } from "@/decisions/decision-sync";
import type { CreateDecisionInput } from "@/domain";
import { openDecisionsDb } from "@/storage/connection";
import { migrate } from "@/storage/migrations";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";
import { SearchRepository } from "@/storage/search-repository";

const context: SaveContext = {
	projectId: "project-1",
	sessionId: "session-1",
	commitSha: null,
	commitDirty: false,
};

let repo: string;
let cortexDir: string;
let db: Database;
let sync: DecisionSync;
let nodes: NodeRepository;
let search: SearchRepository;

function git(...args: string[]): string {
	const result = Bun.spawnSync(
		[
			"git",
			"-c",
			"user.email=test@example.com",
			"-c",
			"user.name=Test",
			...args,
		],
		{ cwd: repo, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

function openStore(): void {
	mkdirSync(cortexDir, { recursive: true });
	db = openDecisionsDb(cortexDir);
	migrate(db);
	db.query(
		"INSERT OR IGNORE INTO nodes (id, kind) VALUES ('project-1', 'project')",
	).run();
	db.query(
		"INSERT OR IGNORE INTO nodes (id, kind) VALUES ('session-1', 'session')",
	).run();
	sync = openDecisionSync({ cortexDir, db });
	nodes = new NodeRepository(db);
	search = new SearchRepository(db);
}

beforeEach(() => {
	repo = realpathSync(mkdtempSync(join(tmpdir(), "cortex-git-backed-")));
	cortexDir = join(repo, ".cortex");
	git("init", "-b", "main");
	// Only the decision files are versioned; the derived cache stays local.
	writeFileSync(join(repo, ".gitignore"), "/.cortex/*\n!/.cortex/decisions/\n");
	git("add", ".gitignore");
	git("commit", "-m", "init", "--no-gpg-sign");
	openStore();
});

afterEach(() => {
	db.close();
	rmSync(repo, { recursive: true, force: true });
});

function decisionInput(
	overrides: Partial<CreateDecisionInput> = {},
): CreateDecisionInput {
	return {
		title: "Adotar JWT para autenticação",
		body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
		keywords: ["autenticação", "authentication", "jwt", "login", "token"],
		...overrides,
	};
}

function commitDecisions(message: string): void {
	git("add", ".cortex/decisions");
	git("commit", "-m", message, "--no-gpg-sign");
}

function activeIds(): string[] {
	return nodes
		.listActive()
		.map((decision) => decision.id)
		.sort();
}

describe("two branches each saving a decision", () => {
	test("merge cleanly, and both are searchable afterwards", () => {
		const onMain = sync.save(
			decisionInput({ keywords: ["autenticação", "jwt", "main"] }),
			context,
		);
		commitDecisions("decision on main");

		git("checkout", "-b", "feature");
		const onFeature = sync.save(
			decisionInput({
				title: "Paginação por cursor nas listagens",
				keywords: ["paginação", "cursor", "listagem", "api", "feature"],
			}),
			context,
		);
		commitDecisions("decision on feature");

		git("checkout", "main");
		const merge = git("merge", "feature", "--no-edit");

		expect(merge).not.toContain("CONFLICT");
		sync.resync();
		expect(activeIds()).toEqual([onMain.id, onFeature.id].sort());
		expect(
			search
				.searchExact(["main", "feature"])
				.map((hit) => hit.nodeId)
				.sort(),
		).toEqual([onMain.id, onFeature.id].sort());
	});
});

describe("a branch that never merges", () => {
	test("its decision is a queryable absence on main, not a ghost", () => {
		const onMain = sync.save(decisionInput(), context);
		commitDecisions("decision on main");

		git("checkout", "-b", "abandoned");
		const abandoned = sync.save(
			decisionInput({
				title: "Cache de sessões no Redis",
				keywords: ["cache", "redis", "ttl", "sessão", "memória"],
			}),
			context,
		);
		commitDecisions("decision on the abandoned branch");
		sync.resync();
		expect(activeIds()).toEqual([onMain.id, abandoned.id].sort());

		git("checkout", "main");
		sync.resync();

		expect(activeIds()).toEqual([onMain.id]);
		expect(nodes.getById(abandoned.id)?.present).toBe(false);
		expect(search.searchExact(["redis"])).toEqual([]);
	});
});

describe("a decision file in git", () => {
	test("shows up as a readable markdown diff", () => {
		sync.save(decisionInput({ module: "auth" }), context);
		commitDecisions("record the JWT decision");

		const diff = git("show", "--format=", "HEAD");

		expect(diff).toContain("+---");
		expect(diff).toContain('+title: "Adotar JWT para autenticação"');
		expect(diff).toContain('+module: "auth"');
		expect(diff).toContain(
			"+Usamos JWTs de curta duração assinados com RS256 para a API.",
		);
	});
});

describe("the database is a derived cache", () => {
	test("deleting it reproduces every decision, anchor and versioned link", () => {
		const base = sync.save(
			decisionInput({
				anchors: [{ file_path: "src/auth/service.ts", symbol: "Auth.login" }],
			}),
			context,
		);
		const dependent = sync.save(
			decisionInput({
				title: "Refresh tokens em cookie httpOnly",
				keywords: ["refresh", "token", "cookie", "sessão", "security"],
				depends_on: [base.id],
			}),
			context,
		);
		sync.save(
			decisionInput({
				title: "Migrar de JWT para sessões opacas",
				keywords: ["sessão", "opaque", "server", "auth", "redis"],
				replaces: base.id,
			}),
			context,
		);
		commitDecisions("record three linked decisions");
		const before = nodes.listActive();

		db.close();
		rmSync(cortexDir, { recursive: true, force: true });
		git("checkout", "--", ".cortex/decisions");
		openStore();
		sync.ensure();

		expect(nodes.listActive()).toEqual(before);
		expect(nodes.getById(base.id)?.status).toBe("replaced");
		expect(nodes.getById(base.id)?.anchors).toEqual([
			{ filePath: "src/auth/service.ts", symbol: "Auth.login" },
		]);
		expect(nodes.getById(dependent.id)?.present).toBe(true);
		expect(
			db
				.query("SELECT count(*) AS n FROM edges WHERE kind = 'DEPENDS_ON'")
				.get(),
		).toEqual({ n: 1 });
		// The session and project history is local, and does not come back.
		expect(
			db
				.query("SELECT count(*) AS n FROM edges WHERE kind = 'GENERATED_IN'")
				.get(),
		).toEqual({ n: 0 });
		expect(nodes.listSessionSummaries(10)).toEqual([]);
	});
});
