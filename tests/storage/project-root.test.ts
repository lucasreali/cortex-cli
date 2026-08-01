import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORTEX_DIRECTORY, ProjectRoot } from "@/storage/project-root";

const created: string[] = [];

function makeDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "cortex-root-"));
	created.push(directory);
	return directory;
}

function initialize(directory: string): void {
	mkdirSync(join(directory, CORTEX_DIRECTORY), { recursive: true });
	writeFileSync(join(directory, CORTEX_DIRECTORY, "decisions.db"), "");
}

afterEach(() => {
	for (const directory of created.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ProjectRoot", () => {
	test("derives every store path from the project directory", () => {
		const project = ProjectRoot.at("/repo");
		expect(project.directory).toBe("/repo");
		expect(project.cortexDir).toBe("/repo/.cortex");
		expect(project.decisionsDbPath).toBe("/repo/.cortex/decisions.db");
		expect(project.codeDbPath).toBe("/repo/.cortex/code.db");
	});

	test("resolves a relative directory against the process cwd", () => {
		expect(ProjectRoot.at(".").directory).toBe(process.cwd());
	});

	test("a store is initialized only once decisions.db exists", () => {
		const directory = makeDir();
		expect(ProjectRoot.at(directory).isInitialized()).toBe(false);
		mkdirSync(join(directory, CORTEX_DIRECTORY));
		expect(ProjectRoot.at(directory).isInitialized()).toBe(false);
		writeFileSync(join(directory, CORTEX_DIRECTORY, "decisions.db"), "");
		expect(ProjectRoot.at(directory).isInitialized()).toBe(true);
	});

	test("nearest walks up to the closest initialized ancestor", () => {
		const root = makeDir();
		initialize(root);
		const nested = join(root, "src", "deep");
		mkdirSync(nested, { recursive: true });
		expect(ProjectRoot.nearest(nested)?.directory).toBe(root);
		expect(ProjectRoot.nearest(root)?.directory).toBe(root);
	});

	test("an inner store wins over the outer one it sits inside", () => {
		const outer = makeDir();
		initialize(outer);
		const inner = join(outer, "packages", "api");
		mkdirSync(inner, { recursive: true });
		initialize(inner);
		expect(ProjectRoot.nearest(join(inner, "src"))?.directory).toBe(inner);
	});

	test("nearest gives up at the filesystem root", () => {
		const orphan = makeDir();
		expect(ProjectRoot.nearest(orphan)).toBeNull();
	});
});
