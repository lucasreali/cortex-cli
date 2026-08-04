import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRuntime } from "@/app/runtime";
import { DecisionStore } from "@/decisions/decision-store";
import { readConfig, writeConfig } from "@/storage/config";
import { SCHEMA_VERSION } from "@/storage/migrations";

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
			dependsOn: [],
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

	test("leaves a missing config alone, so doctor keeps reporting it", async () => {
		const dir = makeProjectDir();
		const runtime = await buildRuntime(dir);
		runtime.dispose();

		expect(await readConfig(join(dir, ".cortex"))).toBeNull();
	});
});
