import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	projectsRegistryPath,
	readRegisteredProjects,
	registerProject,
} from "@/storage/project-registry";

let dir: string;
let previousOverride: string | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-registry-"));
	previousOverride = process.env.CORTEX_PROJECTS_FILE;
	process.env.CORTEX_PROJECTS_FILE = join(dir, "projects.json");
});

afterEach(() => {
	process.env.CORTEX_PROJECTS_FILE = previousOverride;
	rmSync(dir, { recursive: true, force: true });
});

function makeInitializedProject(name: string): string {
	const root = join(dir, name);
	mkdirSync(join(root, ".cortex", "decisions"), { recursive: true });
	return root;
}

describe("project registry", () => {
	test("the env override names the file, and registration lands there", () => {
		const root = makeInitializedProject("alpha");
		registerProject(root, "github.com/acme/alpha");

		expect(projectsRegistryPath()).toBe(join(dir, "projects.json"));
		expect(readRegisteredProjects()).toEqual([
			{
				root,
				canonicalId: "github.com/acme/alpha",
				registeredAt: expect.any(String),
			},
		]);
	});

	test("registering the same root twice keeps one entry", () => {
		const root = makeInitializedProject("alpha");
		registerProject(root, "github.com/acme/alpha");
		const written = readFileSync(join(dir, "projects.json"), "utf8");

		registerProject(root, "github.com/acme/alpha");

		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe(written);
		expect(readRegisteredProjects()).toHaveLength(1);
	});

	test("an entry whose store disappeared is pruned on read", () => {
		const kept = makeInitializedProject("alpha");
		const doomed = makeInitializedProject("beta");
		registerProject(kept, "github.com/acme/alpha");
		registerProject(doomed, "github.com/acme/beta");

		rmSync(join(doomed, ".cortex"), { recursive: true, force: true });

		expect(readRegisteredProjects().map((project) => project.root)).toEqual([
			kept,
		]);
		expect(readFileSync(join(dir, "projects.json"), "utf8")).not.toContain(
			"beta",
		);
	});

	test("an absent registry reads as empty", () => {
		expect(readRegisteredProjects()).toEqual([]);
	});

	test("a corrupt registry file reads as empty and is recoverable", async () => {
		await Bun.write(join(dir, "projects.json"), "{ not json");
		expect(readRegisteredProjects()).toEqual([]);

		const root = makeInitializedProject("alpha");
		registerProject(root, "github.com/acme/alpha");
		expect(readRegisteredProjects()).toHaveLength(1);
	});

	test("entries with the wrong shape are ignored", async () => {
		const root = makeInitializedProject("alpha");
		await Bun.write(
			join(dir, "projects.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{ root, canonical_id: "acme/alpha", registered_at: "2026-01-01" },
					{ root: 42 },
					"nope",
				],
			}),
		);

		expect(readRegisteredProjects().map((project) => project.root)).toEqual([
			root,
		]);
	});

	test("registration failures are swallowed, never thrown", async () => {
		await Bun.write(join(dir, "blocker"), "a file, not a directory");
		process.env.CORTEX_PROJECTS_FILE = join(dir, "blocker", "projects.json");

		expect(() =>
			registerProject(makeInitializedProject("alpha"), "acme/alpha"),
		).not.toThrow();
	});
});
