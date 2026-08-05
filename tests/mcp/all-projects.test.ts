import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callTool, connect, makeTempDir } from "./harness";

let registryDir: string;
let alpha: string;
let beta: string;
let client: Client;

// The registry file is scoped to this suite so the projects other test files
// initialize never leak into these assertions.
function registryEnv(name: string): Record<string, string> {
	return { CORTEX_PROJECTS_FILE: join(registryDir, name) };
}

beforeAll(async () => {
	registryDir = makeTempDir("cortex-all-projects-registry-");
	const env = registryEnv("projects.json");
	alpha = makeProjectWithEnv(
		"cortex-xp-alpha-",
		"git@github.com:acme/alpha.git",
		env,
	);
	beta = makeProjectWithEnv(
		"cortex-xp-beta-",
		"git@github.com:acme/beta.git",
		env,
	);
	client = await connect(alpha, env);

	const inAlpha = await callTool(client, "save_decision", {
		title: "Rate limiting com janela deslizante no alpha",
		body: "Janela deslizante em Redis limita requisições por chave de API.",
		keywords: ["rate", "limiting", "redis", "janela", "api"],
	});
	expect(inAlpha.isError).toBe(false);
	const inBeta = await callTool(client, "save_decision", {
		title: "Rate limiting delegado ao gateway no beta",
		body: "O gateway aplica os limites; o serviço não conta requisições.",
		keywords: ["rate", "limiting", "gateway", "limites", "api"],
		projectPath: beta,
	});
	expect(inBeta.isError).toBe(false);
}, 30_000);

afterAll(async () => {
	await client?.close();
	for (const dir of [alpha, beta, registryDir]) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeProjectWithEnv(
	prefix: string,
	remote: string,
	env: Record<string, string>,
): string {
	const dir = makeTempDir(prefix);
	const spawn = (...command: string[]) => {
		const result = Bun.spawnSync(command, {
			cwd: dir,
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		if (result.exitCode !== 0) {
			throw new Error(`${command.join(" ")}: ${result.stderr.toString()}`);
		}
	};
	spawn("git", "init", "-b", "main");
	spawn("git", "remote", "add", "origin", remote);
	spawn(
		"bun",
		new URL("../../src/cli/main.ts", import.meta.url).pathname,
		"init",
		"--yes",
	);
	return dir;
}

describe("search_all_projects", () => {
	test("finds decisions across projects, grouped and labeled", async () => {
		const { isError, payload } = await callTool(client, "search_all_projects", {
			terms: ["rate", "limiting"],
			exact: true,
		});

		expect(isError).toBe(false);
		const byProject = new Map(
			payload.projects.map((entry: { project: string }) => [
				entry.project,
				entry,
			]),
		);
		const alphaGroup = byProject.get("github.com/acme/alpha") as {
			results: Array<{ title: string; source: string }>;
		};
		const betaGroup = byProject.get("github.com/acme/beta") as {
			results: Array<{ title: string }>;
		};
		expect(alphaGroup.results.map((result) => result.title)).toContain(
			"Rate limiting com janela deslizante no alpha",
		);
		expect(betaGroup.results.map((result) => result.title)).toContain(
			"Rate limiting delegado ao gateway no beta",
		);
	});

	test("an empty registry answers with guidance, not an error", async () => {
		const outside = makeTempDir("cortex-xp-outside-");
		const bare = await connect(outside, registryEnv("empty.json"));
		try {
			const { isError, payload } = await callTool(bare, "search_all_projects", {
				terms: ["rate"],
			});
			expect(isError).toBe(false);
			expect(payload.status).toBe("no_projects");
			expect(payload.guidance).toContain("cortex init");
		} finally {
			await bare.close();
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a registered project whose store vanished is pruned, not fatal", async () => {
		const doomed = makeProjectWithEnv(
			"cortex-xp-doomed-",
			"git@github.com:acme/doomed.git",
			registryEnv("projects.json"),
		);
		rmSync(join(doomed, ".cortex"), { recursive: true, force: true });

		const { isError, payload } = await callTool(client, "search_all_projects", {
			terms: ["rate"],
			exact: true,
		});

		expect(isError).toBe(false);
		const roots = payload.projects.map(
			(entry: { project: string }) => entry.project,
		);
		expect(roots).not.toContain("github.com/acme/doomed");
		rmSync(doomed, { recursive: true, force: true });
	});
});
