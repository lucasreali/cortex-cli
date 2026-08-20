import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime, type CortexRuntime } from "@/app/runtime";
import { DecisionStore } from "@/decisions/decision-store";
import { readConfig, writeConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";
import { ProjectRoot } from "@/storage/project-root";
import { UsefulnessEventLog } from "@/usefulness/event-log";
import { UsefulnessRecorder } from "@/usefulness/recorder";

function makeProjectDir(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), "cortex-runtime-")));
}

async function buildOver(
	dir: string,
	schemaVersion: number,
): Promise<number | undefined> {
	const cortexDir = join(dir, ".cortex");
	mkdirSync(cortexDir, { recursive: true });
	await writeConfig(cortexDir, {
		model_id: "embeddinggemma-300m-q8@256",
		schema_version: schemaVersion,
	});
	const runtime = await buildRuntime(dir);
	runtime.dispose();
	return (await readConfig(cortexDir))?.schema_version;
}

function writeDecision(
	dir: string,
	id: string,
	title: string,
	keywords: string[],
): void {
	DecisionStore.at(join(dir, ".cortex")).write({
		id,
		title,
		body: `${title} — decisão de fixture para exercitar a busca.`,
		keywords,
		module: null,
		replaces: null,
		archives: null,
		dependsOn: [],
		conflictsWith: [],
		anchors: [],
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		createdAt: "2026-07-22T14:03:11.204Z",
	});
}

function logIn(dir: string): UsefulnessEventLog {
	return new UsefulnessEventLog(ProjectRoot.at(dir).usefulnessLogPath);
}

async function searchIn(
	dir: string,
	before: (runtime: CortexRuntime) => void = () => {},
): Promise<string[]> {
	const runtime = await buildRuntime(dir);
	try {
		runtime.decisions.ensure();
		before(runtime);
		const results = await runtime.semanticSearch.search("jwt migrations");
		return results.map((result) => result.node.id);
	} finally {
		runtime.dispose();
	}
}

describe("buildRuntime", () => {
	test("outside a git repo it roots the store at the given directory", async () => {
		const dir = makeProjectDir();
		const runtime = await buildRuntime(dir);
		try {
			expect(runtime.repoRoot).toBe(dir);
			expect(runtime.cortexDir).toBe(join(dir, ".cortex"));
		} finally {
			runtime.dispose();
		}
	});

	test("ensureSession reuses one session; saveContext carries it without git", async () => {
		const runtime = await buildRuntime(makeProjectDir());
		try {
			const session = runtime.ensureSession();
			expect(runtime.ensureSession()).toBe(session);

			const context = runtime.saveContext();
			expect(context).toEqual({
				projectId: runtime.projectNodeId,
				sessionId: session,
				commitSha: null,
				commitDirty: false,
			});
		} finally {
			runtime.dispose();
		}
	});

	test("raises a stale schema_version in the config, never lowers it", async () => {
		expect(await buildOver(makeProjectDir(), SCHEMA_VERSION - 1)).toBe(
			SCHEMA_VERSION,
		);
		expect(await buildOver(makeProjectDir(), SCHEMA_VERSION + 1)).toBe(
			SCHEMA_VERSION + 1,
		);
	});

	test("a decision file already on the branch is imported and queued", async () => {
		const dir = makeProjectDir();
		const id = "019f0000-0000-7000-8000-000000000001";
		DecisionStore.at(join(dir, ".cortex")).write({
			id,
			title: "Adotar JWT para autenticação",
			body: "Usamos JWTs de curta duração assinados com RS256 para a API.",
			keywords: ["autenticação", "authentication", "jwt", "login", "token"],
			module: null,
			replaces: null,
			archives: null,
			dependsOn: [],
			conflictsWith: [],
			anchors: [],
			commitSha: null,
			commitDirty: false,
			provenance: "agent",
			createdAt: "2026-07-22T14:03:11.204Z",
		});

		const runtime = await buildRuntime(dir);
		try {
			expect(runtime.decisions.ensure().imported).toEqual([id]);
			expect(runtime.nodes.listActive().map((one) => one.id)).toEqual([id]);
		} finally {
			runtime.dispose();
		}
	});

	test("the usefulness log reaches both the recorder and the ranking", async () => {
		const dir = makeProjectDir();
		writeDecision(dir, "019f0000-0000-7000-8000-00000000000a", "Adotar JWT", [
			"jwt",
			"login",
			"token",
			"autenticação",
			"segurança",
		]);
		writeDecision(dir, "019f0000-0000-7000-8000-00000000000b", "PostgreSQL", [
			"postgres",
			"banco",
			"database",
			"sql",
			"migrations",
		]);
		const baseline = await searchIn(dir);
		const runnerUp = baseline[1] as string;
		new UsefulnessRecorder(logIn(dir), "earlier-session").used([runnerUp]);

		const reranked = await searchIn(dir, (runtime) => {
			runtime.usefulness.used([runnerUp]);
		});

		expect(baseline).toHaveLength(2);
		expect(reranked).toEqual([runnerUp, baseline[0] as string]);
		expect(logIn(dir).scores().get(runnerUp)).toBeGreaterThan(0);
	});

	test("leaves a missing config alone, so doctor keeps reporting it", async () => {
		const dir = makeProjectDir();
		const runtime = await buildRuntime(dir);
		runtime.dispose();

		expect(await readConfig(join(dir, ".cortex"))).toBeNull();
	});

	// The MCP server retries a project on every tool call, so a store that
	// fails to build must not cost a descriptor per attempt.
	test("a store that fails to build releases its connection", async () => {
		const dir = makeProjectDir();
		const cortexDir = join(dir, ".cortex");
		mkdirSync(cortexDir, { recursive: true });
		const conflicting = new Database(join(cortexDir, "decisions.db"), {
			create: true,
		});
		conflicting.run("CREATE TABLE nodes (unexpected INTEGER)");
		conflicting.close();
		const baseline = openDescriptors();

		for (let attempt = 0; attempt < 30; attempt += 1) {
			await expect(buildRuntime(dir)).rejects.toThrow();
		}

		expect(openDescriptors()).toBeLessThanOrEqual(baseline);
	});

	test("a file that is not a database releases its connection too", async () => {
		const dir = makeProjectDir();
		const cortexDir = join(dir, ".cortex");
		mkdirSync(cortexDir, { recursive: true });
		await Bun.write(join(cortexDir, "decisions.db"), "not a database at all");
		const baseline = openDescriptors();

		for (let attempt = 0; attempt < 30; attempt += 1) {
			await expect(buildRuntime(dir)).rejects.toThrow();
		}

		expect(openDescriptors()).toBeLessThanOrEqual(baseline);
	});
});

function openDescriptors(): number {
	return readdirSync("/dev/fd").length;
}
