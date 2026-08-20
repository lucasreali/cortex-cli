import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	corruptRegistryBackups,
	projectsRegistryPath,
	readProjectRegistry,
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
	chmodSync(dir, 0o755);
	rmSync(dir, { recursive: true, force: true });
});

function makeInitializedProject(name: string): string {
	const root = join(dir, name);
	mkdirSync(join(root, ".cortex", "decisions"), { recursive: true });
	return root;
}

function registeredRoots(): string[] {
	const read = readProjectRegistry();
	return read.state === "ok"
		? read.projects.map((project) => project.root)
		: [];
}

describe("project registry", () => {
	test("the env override names the file, and registration lands there", () => {
		const root = makeInitializedProject("alpha");
		registerProject(root, "github.com/acme/alpha");

		expect(projectsRegistryPath()).toBe(join(dir, "projects.json"));
		expect(readProjectRegistry()).toEqual({
			state: "ok",
			projects: [
				{
					root,
					canonicalId: "github.com/acme/alpha",
					registeredAt: expect.any(String),
				},
			],
		});
	});

	test("registering the same root twice keeps one entry", () => {
		const root = makeInitializedProject("alpha");
		registerProject(root, "github.com/acme/alpha");
		const written = readFileSync(join(dir, "projects.json"), "utf8");

		registerProject(root, "github.com/acme/alpha");

		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe(written);
		expect(registeredRoots()).toHaveLength(1);
	});

	test("an entry whose store disappeared is filtered out, without a write", () => {
		const kept = makeInitializedProject("alpha");
		const doomed = makeInitializedProject("beta");
		registerProject(kept, "github.com/acme/alpha");
		registerProject(doomed, "github.com/acme/beta");
		const written = readFileSync(join(dir, "projects.json"), "utf8");

		rmSync(join(doomed, ".cortex"), { recursive: true, force: true });

		expect(registeredRoots()).toEqual([kept]);
		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe(written);
	});

	test("a vanished entry is dropped by the next registration", () => {
		const kept = makeInitializedProject("alpha");
		const doomed = makeInitializedProject("beta");
		registerProject(kept, "github.com/acme/alpha");
		registerProject(doomed, "github.com/acme/beta");
		rmSync(join(doomed, ".cortex"), { recursive: true, force: true });

		registerProject(makeInitializedProject("gamma"), "github.com/acme/gamma");

		expect(readFileSync(join(dir, "projects.json"), "utf8")).not.toContain(
			"beta",
		);
	});

	// A store behind an unreadable directory is not a store that is gone: the
	// read has to come back empty for this call without forgetting the project.
	test("an unreadable store is skipped on read but never forgotten", () => {
		const kept = makeInitializedProject("alpha");
		const blocked = makeInitializedProject("beta");
		registerProject(kept, "github.com/acme/alpha");
		registerProject(blocked, "github.com/acme/beta");
		chmodSync(blocked, 0o000);

		try {
			expect(registeredRoots()).toEqual([kept]);
			registerProject(makeInitializedProject("gamma"), "github.com/acme/gamma");
			expect(readFileSync(join(dir, "projects.json"), "utf8")).toContain(
				"beta",
			);
		} finally {
			chmodSync(blocked, 0o755);
		}
	});

	test("an absent registry reads as missing", () => {
		expect(readProjectRegistry()).toEqual({ state: "missing" });
		expect(corruptRegistryBackups()).toEqual([]);
	});

	test("reading a corrupt registry reports it and changes nothing", async () => {
		await Bun.write(join(dir, "projects.json"), "{ not json");

		expect(readProjectRegistry()).toEqual({ state: "unreadable" });

		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe("{ not json");
		expect(corruptRegistryBackups()).toEqual([]);
	});

	test("registering over a corrupt registry keeps the original aside", async () => {
		await Bun.write(join(dir, "projects.json"), "{ not json");
		const root = makeInitializedProject("alpha");

		registerProject(root, "github.com/acme/alpha");

		const backups = corruptRegistryBackups();
		expect(backups).toHaveLength(1);
		expect(readFileSync(backups[0] as string, "utf8")).toBe("{ not json");
		expect(registeredRoots()).toEqual([root]);

		registerProject(makeInitializedProject("beta"), "github.com/acme/beta");
		expect(corruptRegistryBackups()).toEqual(backups);
	});

	test("a registry whose projects field is not a list is corrupt too", async () => {
		await Bun.write(
			join(dir, "projects.json"),
			JSON.stringify({ version: 1, projects: "nope" }),
		);

		expect(readProjectRegistry()).toEqual({ state: "unreadable" });

		registerProject(makeInitializedProject("alpha"), "github.com/acme/alpha");
		expect(corruptRegistryBackups()).toHaveLength(1);
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

		expect(registeredRoots()).toEqual([root]);
		expect(corruptRegistryBackups()).toEqual([]);
	});

	// Runs as a plain user; under root the read-only directory would not stop
	// the write and the assertions below would pass vacuously.
	test("a corrupt registry that cannot be moved aside is left alone", async () => {
		await Bun.write(join(dir, "projects.json"), "{ not json");
		chmodSync(dir, 0o555);

		expect(() =>
			registerProject(join(dir, "alpha"), "github.com/acme/alpha"),
		).not.toThrow();

		expect(readFileSync(join(dir, "projects.json"), "utf8")).toBe("{ not json");
		expect(corruptRegistryBackups()).toEqual([]);
	});

	test("registration failures are swallowed, never thrown", async () => {
		await Bun.write(join(dir, "blocker"), "a file, not a directory");
		process.env.CORTEX_PROJECTS_FILE = join(dir, "blocker", "projects.json");

		expect(() =>
			registerProject(makeInitializedProject("alpha"), "acme/alpha"),
		).not.toThrow();
		expect(readProjectRegistry()).toEqual({ state: "missing" });
		expect(corruptRegistryBackups()).toEqual([]);
	});
});
