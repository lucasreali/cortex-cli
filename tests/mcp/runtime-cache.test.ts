import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	callTool,
	connect,
	makeProject,
	makeTempDir,
	serverDescriptors,
} from "./harness";

// Comfortably above the server's cache cap, so the difference between an
// unbounded Map and an LRU is visible in the descriptor count.
const PROJECT_COUNT = 16;

let registryDir: string;
let projects: string[];
let client: Client;

beforeAll(async () => {
	registryDir = makeTempDir("cortex-cache-registry-");
	const env = { CORTEX_PROJECTS_FILE: join(registryDir, "projects.json") };
	projects = Array.from({ length: PROJECT_COUNT }, (_, index) =>
		makeProject(
			`cortex-cache-${index}-`,
			`git@github.com:acme/c${index}.git`,
			env,
		),
	);
	client = await connect(projects[0] as string, env);
}, 60_000);

afterAll(async () => {
	await client?.close();
	for (const dir of [...projects, registryDir]) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function searchIn(projectPath: string): Promise<void> {
	const { isError } = await callTool(client, "search", {
		terms: ["rate", "limiting"],
		exact: true,
		projectPath,
	});
	expect(isError).toBe(false);
}

describe("the MCP runtime cache", () => {
	// Every cached runtime holds an open decisions.db (plus its -wal and -shm),
	// so before the LRU each new project cost the server descriptors it never
	// gave back — 25 projects took one server from 13 to 94 open fds.
	test.skipIf(!existsSync("/proc/self/fd"))(
		"stays bounded as a session touches more projects than it can hold",
		async () => {
			for (const project of projects.slice(0, 4)) await searchIn(project);
			const afterFour = serverDescriptors(client);

			for (const project of projects) await searchIn(project);
			for (const project of projects) await searchIn(project);

			// Four projects cost ~22 descriptors; sixteen cost ~34 behind the
			// cap and ~58 without it, so doubling is the line between the two.
			expect(serverDescriptors(client)).toBeLessThan(afterFour * 2);
		},
		60_000,
	);

	test("every project still answers, whatever the cache evicted", async () => {
		for (const project of projects) await searchIn(project);
	}, 60_000);
});
