import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DRIVER_PATH = new URL("../fixtures/embed-all-driver.ts", import.meta.url)
	.pathname;

describe("embedAll", () => {
	test("a hung worker times out, is disposed and leaves the item pending", () => {
		const dir = mkdtempSync(join(tmpdir(), "cortex-embed-all-"));
		try {
			const result = Bun.spawnSync(["bun", DRIVER_PATH, dir], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout.toString()).toContain("disposed");
			expect(result.stdout.toString()).toContain("pending:1");
			expect(result.stderr.toString()).toContain("timed out after 50 ms");
			expect(result.stderr.toString()).toContain("no vector returned");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 15_000);
});
