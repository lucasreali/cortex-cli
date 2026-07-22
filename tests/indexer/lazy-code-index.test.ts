import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { LazyCodeIndex } from "@/indexer/lazy-code-index";
import { openCodeRepository } from "@/storage/code-db";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-lazy-index-"));
	mkdirSync(join(dir, ".cortex"));
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("LazyCodeIndex", () => {
	test("the first access reconciles the index", async () => {
		const lazy = new LazyCodeIndex(dir);
		const repository = await lazy.repository();

		expect(repository.listFiles().map((file) => file.path)).toEqual([
			"src/a.ts",
		]);
		lazy.dispose();
	});

	test("later accesses in the same session reuse the reconciled index", async () => {
		const lazy = new LazyCodeIndex(dir);
		await lazy.repository();
		writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");

		const repository = await lazy.repository();

		expect(repository.listFiles()).toHaveLength(1);
		lazy.dispose();
	});

	test("a new session catches up on edits made while it was down", async () => {
		const first = new LazyCodeIndex(dir);
		await first.repository();
		first.dispose();
		writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");

		const second = new LazyCodeIndex(dir);
		const repository = await second.repository();

		expect(repository.listFiles()).toHaveLength(2);
		second.dispose();
	});

	test("a stale extraction stamp triggers a full rebuild on reconcile", async () => {
		writeFileSync(join(dir, "src/a.ts"), "export const a = () => 1;\n");
		const first = new LazyCodeIndex(dir);
		await first.repository();
		first.dispose();
		const open = openCodeRepository(join(dir, ".cortex"));
		open.database.run("DELETE FROM symbols");
		open.repository.stampExtractionVersion(EXTRACTION_VERSION - 1);
		open.database.close();

		const second = new LazyCodeIndex(dir);
		const repository = await second.repository();

		expect(repository.symbolsIn("src/a.ts").map((s) => s.name)).toEqual(["a"]);
		expect(repository.extractionVersion()).toBe(EXTRACTION_VERSION);
		second.dispose();
	});

	test("dispose is safe to call twice and allows reopening", async () => {
		const lazy = new LazyCodeIndex(dir);
		await lazy.repository();
		lazy.dispose();
		lazy.dispose();

		expect((await lazy.repository()).listFiles()).toHaveLength(1);
		lazy.dispose();
	});
});
