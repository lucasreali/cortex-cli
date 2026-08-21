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
import { GEMMA_MODEL } from "@/embedding/model";
import { markModelResident } from "@/embedding/model-cache";
import { readConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";

// Two named gaps at once. `embed --rebuild` had zero executions anywhere — the
// consent prompt, the re-embed of every active decision and the config
// model_id it writes afterwards were reachable only by a person running it by
// hand. And `doctor` never exited 0 in any test: every project the suite builds
// has something outstanding, so the one path that says "All checks passed" was
// never taken, and a check that started warning unconditionally would have gone
// unnoticed.
//
// Both need a project where nothing is outstanding, which needs embeddings —
// so the fake worker stands in for the model, as it does for the git hooks.
const MAIN_PATH = new URL("../../src/cli/main.ts", import.meta.url).pathname;
const FAKE_WORKER = new URL(
	"../fixtures/fake-embedding-worker.ts",
	import.meta.url,
).pathname;

const DECISION = {
	title: "Adotar RRF para fundir os rankings da busca",
	keywords: ["busca", "search", "rrf", "ranking", "fusão"],
};

let dir: string;
let models: string;

function cli(...args: string[]) {
	const result = Bun.spawnSync(["bun", MAIN_PATH, ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			CORTEX_DISABLE_EMBEDDINGS: "",
			CORTEX_EMBED_WORKER_PATH: FAKE_WORKER,
			CORTEX_NO_DAEMON: "1",
			CORTEX_MODELS_DIR: models,
		},
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

function writeDecision(id: string): void {
	mkdirSync(join(dir, ".cortex", "decisions"), { recursive: true });
	writeFileSync(
		join(dir, ".cortex", "decisions", `${id}.md`),
		[
			"---",
			`title: ${JSON.stringify(DECISION.title)}`,
			`keywords: ${JSON.stringify(DECISION.keywords)}`,
			'provenance: "agent"',
			'created_at: "2026-08-14T12:00:00.000Z"',
			"---",
			"",
			"Vector and BM25 rankings are fused with reciprocal rank fusion.",
			"",
		].join("\n"),
	);
}

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-healthy-")));
	// Nothing outstanding includes the model: the fake worker never fetches one,
	// so the marker that says it is here is stamped by hand.
	models = realpathSync(mkdtempSync(join(tmpdir(), "cortex-healthy-models-")));
	markModelResident(models);
	git("init", "-b", "main");
	git("remote", "add", "origin", "git@github.com:acme/healthy.git");
	mkdirSync(join(dir, "src"));
	writeFileSync(
		join(dir, "src", "search.ts"),
		"export function fuse(rankings: number[][]): number[] {\n\treturn rankings.flat();\n}\n",
	);
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
	expect(cli("init", "--yes").code).toBe(0);
	writeDecision("01a02000-0000-7000-8000-000000000001");
	expect(cli("index").code).toBe(0);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(models, { recursive: true, force: true });
});

describe("cortex embed --rebuild", () => {
	test("refuses to re-embed everything without consent", () => {
		const result = cli("embed", "--rebuild");

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Rebuild needs confirmation");
	});

	test("--yes re-embeds every active decision", () => {
		const result = cli("embed", "--rebuild", "--yes");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(DECISION.title);
		expect(result.stdout).toContain("Embedded 1 decision(s).");
	}, 30_000);

	// A rebuild is how a store gets its vectors back after a model change, so
	// the pin has to follow them: a config with no model_id in it must come out
	// naming the model the rebuild actually embedded with.
	test("--yes repoints the config at the model it embedded with", async () => {
		const cortexDir = join(dir, ".cortex");
		rmSync(join(cortexDir, "config"), { force: true });

		const result = cli("embed", "--rebuild", "--yes");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain(
			`Config model_id updated to ${GEMMA_MODEL.modelId}`,
		);
		const config = await readConfig(cortexDir);
		expect(config?.model_id).toBe(GEMMA_MODEL.modelId);
		expect(config?.schema_version).toBe(SCHEMA_VERSION);
	}, 30_000);

	test("leaves the config alone when the pin already matches", async () => {
		const result = cli("embed", "--rebuild", "--yes");

		expect(result.code).toBe(0);
		expect(result.stdout).not.toContain("Config model_id updated");
	}, 30_000);
});

describe("cortex doctor on a project with nothing outstanding", () => {
	test("embed --missing has nothing left to do", () => {
		const result = cli("embed", "--missing");

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Nothing to embed.");
	}, 30_000);

	// The one path that reports a clean bill of health, and the only exit code
	// a caller can act on.
	test("says every check passed, and exits 0", () => {
		const result = cli("doctor");

		expect(result.stdout).toContain("All checks passed.");
		expect(result.code).toBe(0);
	}, 30_000);

	test("--json says the same thing in a machine-readable shape", () => {
		const result = cli("doctor", "--json");

		expect(result.code).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(
			report.checks.filter((check: { level: string }) => check.level !== "ok"),
		).toEqual([]);
	}, 30_000);
});
