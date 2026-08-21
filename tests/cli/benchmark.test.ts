import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDecision } from "@tests/support/seed";
import { openDecisionsDb } from "@/storage/connection";
import { NodeRepository, type SaveContext } from "@/storage/node-repository";

const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;

let dir: string;
let fakeHome: string;

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
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-benchmark-")));
	fakeHome = realpathSync(mkdtempSync(join(tmpdir(), "cortex-home-")));
	git("init", "-b", "main");
	git("remote", "add", "origin", "git@github.com:acme/demo.git");
	mkdirSync(join(dir, "src/auth"), { recursive: true });
	writeFileSync(
		join(dir, "src/auth/service.ts"),
		"export const authentication = 1;\n".repeat(40),
	);
	writeFileSync(join(dir, "README.md"), "demo repository\n".repeat(40));
	git("add", ".");
	expect(cli("init", "--yes").code).toBe(0);
	seedDecisions();
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(fakeHome, { recursive: true, force: true });
});

function seedDecisions(): void {
	const db: Database = openDecisionsDb(join(dir, ".cortex"));
	const nodes = new NodeRepository(db);
	const projectId = nodes.ensureProject("github.com/acme/demo");
	const context: SaveContext = {
		projectId,
		sessionId: nodes.createSession(projectId),
		commitSha: "sha-1",
		commitDirty: false,
	};
	seedDecision(
		join(dir, ".cortex"),
		db,
		{
			title: "Adotar JWT para autenticação",
			body: "Tokens de acesso de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			anchors: [{ file_path: "src/auth/service.ts" }],
		},
		context,
	);
	seedDecision(
		join(dir, ".cortex"),
		db,
		{
			title: "Refresh tokens em cookie httpOnly",
			body: "Refresh tokens rotacionados a cada uso ficam em cookie httpOnly.",
			keywords: ["refresh", "token", "cookie", "sessão", "security"],
		},
		context,
	);
	db.close();
}

describe("cortex benchmark", () => {
	test("prints the economy table, naming its token method", () => {
		const result = cli("benchmark");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("cortex benchmark  github.com/acme/demo");
		expect(result.stdout).toContain("atoms-per-5-bytes/v1");
		expect(result.stdout).toContain("whole decision corpus (2 decisions)");
		expect(result.stdout).toContain("cortex answer");
		expect(result.stdout).toContain("self-retrieval hit rate");
	});

	test("without the model it says so instead of pretending", () => {
		expect(cli("benchmark").stdout).toContain("retrieval fts only");
	});

	test("--json carries the per-question detail", () => {
		const result = cli("benchmark", "--json");
		const report = JSON.parse(result.stdout);

		expect(result.code).toBe(0);
		expect(report.questions).toBe(2);
		expect(report.corpus.decisions).toBe(2);
		expect(report.repository.files).toBeGreaterThan(0);
		expect(report.cases).toHaveLength(2);
		expect(report.method.id).toBe("atoms-per-5-bytes/v1");
	});

	test("--limit shortens the fixed question list", () => {
		const report = JSON.parse(
			cli("benchmark", "--limit", "1", "--json").stdout,
		);

		expect(report.questions).toBe(1);
		expect(report.cases).toHaveLength(1);
	});

	test("a limit that is not a count is a usage error", () => {
		const result = cli("benchmark", "--limit", "zero");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("usage: cortex benchmark");
	});

	test("--write generates BENCHMARKS.md, stating method, size and date", async () => {
		const result = cli("benchmark", "--write");
		const markdown = await Bun.file(join(dir, "BENCHMARKS.md")).text();

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("wrote BENCHMARKS.md");
		expect(markdown).toContain("# Benchmarks");
		expect(markdown).toContain("atoms-per-5-bytes/v1");
		expect(markdown).toContain("2 decisions");
		expect(markdown).toMatch(/on \d{4}-\d{2}-\d{2} with cortex /);
	});

	// The command owns this file only because it stamped it. A BENCHMARKS.md
	// somebody wrote by hand is not a stale artifact to regenerate.
	// A file the baseline cannot read is a file the baseline is not charged for,
	// which quietly understates the alternative cortex is compared against.
	test("a file the baseline could not read is said out loud", () => {
		const broken = join(dir, "broken.txt");
		symlinkSync("nowhere", broken);

		const result = cli("benchmark");

		expect(result.code).toBe(0);
		expect(result.stderr).toContain("could not be read");
		expect(result.stderr).toContain("broken.txt");
		rmSync(broken);
	});

	test("--write refuses a BENCHMARKS.md it did not write", () => {
		const path = join(dir, "BENCHMARKS.md");
		const mine = "# Benchmarks\n\nmy own notes, please keep\n";
		writeFileSync(path, mine);

		const result = cli("benchmark", "--write");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("will not be replaced");
		expect(readFileSync(path, "utf8")).toBe(mine);
		rmSync(path);
	});

	test("a re-run that measured the same thing does not re-stamp the date", () => {
		const path = join(dir, "BENCHMARKS.md");
		rmSync(path, { force: true });
		expect(cli("benchmark", "--write").code).toBe(0);
		const first = readFileSync(path, "utf8");

		const again = cli("benchmark", "--write");

		expect(again.code).toBe(0);
		expect(again.stdout).toContain("already current");
		expect(readFileSync(path, "utf8")).toBe(first);
	});

	test("the generated file is excluded from the repository it measures", () => {
		const first = JSON.parse(cli("benchmark", "--json").stdout);
		const second = JSON.parse(cli("benchmark", "--json").stdout);

		expect(second.repository).toEqual(first.repository);
	});

	test("it is listed in the help", () => {
		expect(cli("--help").stdout).toContain("benchmark");
	});
});
