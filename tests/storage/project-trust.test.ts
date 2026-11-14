import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isTrustedProject,
	revokeProject,
	trustFilePath,
	trustProject,
} from "@/storage/project-trust";

let dir: string;
let file: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-trust-"));
	file = join(dir, "home", "trusted-projects.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("project trust", () => {
	test("nothing is trusted until someone trusts it, and revoking undoes it", () => {
		expect(isTrustedProject(dir, file)).toBe(false);
		expect(trustProject(dir, file)).toBe(true);
		expect(trustProject(dir, file)).toBe(false);
		expect(isTrustedProject(dir, file)).toBe(true);
		expect(revokeProject(dir, file)).toBe(true);
		expect(revokeProject(dir, file)).toBe(false);
		expect(isTrustedProject(dir, file)).toBe(false);
	});

	test("a path through a symlink names the same project", () => {
		const link = join(dir, "link");
		symlinkSync(dir, link);
		trustProject(link, file);
		expect(isTrustedProject(dir, file)).toBe(true);
	});

	test("an unreadable list trusts nothing", () => {
		trustProject(dir, file);
		writeFileSync(file, "not json");
		expect(isTrustedProject(dir, file)).toBe(false);
		writeFileSync(file, JSON.stringify({ projects: [dir, 7] }));
		expect(isTrustedProject(join(dir, "gone"), file)).toBe(false);
	});

	test("lives in the user's cortex directory", () => {
		expect(trustFilePath()).toEndWith(join(".cortex", "trusted-projects.json"));
	});
});
