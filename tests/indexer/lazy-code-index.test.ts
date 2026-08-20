import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTRACTION_VERSION } from "@/indexer/extraction-version";
import { LazyCodeIndex, RECHECK_AFTER_MS } from "@/indexer/lazy-code-index";
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

const PROCESS_DESCRIPTORS = "/proc/self/fd";

function codeDbDescriptors(): number {
	return readdirSync(PROCESS_DESCRIPTORS).filter((descriptor) =>
		targetOf(descriptor).endsWith("code.db"),
	).length;
}

function dropFilesTable(): void {
	const open = openCodeRepository(join(dir, ".cortex"));
	open.database.run("DROP TABLE files");
	open.database.close();
}

function discardCodeDb(): void {
	for (const suffix of ["", "-wal", "-shm"]) {
		rmSync(join(dir, `.cortex/code.db${suffix}`), { force: true });
	}
}

function targetOf(descriptor: string): string {
	try {
		return readlinkSync(join(PROCESS_DESCRIPTORS, descriptor));
	} catch {
		return "";
	}
}

describe("LazyCodeIndex", () => {
	test("the first access reconciles the index", async () => {
		const lazy = new LazyCodeIndex(dir);
		const repository = await lazy.repository();

		expect(repository.listFiles().map((file) => file.path)).toEqual([
			"src/a.ts",
		]);
		lazy.dispose();
	});

	test("accesses inside the freshness window reuse the reconciled index", async () => {
		const lazy = new LazyCodeIndex(dir, () => 0);
		await lazy.repository();
		writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");

		const repository = await lazy.repository();

		expect(repository.listFiles()).toHaveLength(1);
		lazy.dispose();
	});

	// A long-lived server would otherwise answer every request of every session
	// from the snapshot it took at startup, and call an anchor on code the model
	// just wrote unresolved.
	test("an access past the window re-checks the working tree", async () => {
		let now = 0;
		const lazy = new LazyCodeIndex(dir, () => now);
		await lazy.repository();
		writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");
		now += RECHECK_AFTER_MS;

		const repository = await lazy.repository();

		expect(repository.listFiles()).toHaveLength(2);
		lazy.dispose();
	});

	test("the re-check keeps the connection and the parser it already has", async () => {
		let now = 0;
		const lazy = new LazyCodeIndex(dir, () => now);
		const first = await lazy.repository();
		now += RECHECK_AFTER_MS;

		const second = await lazy.repository();

		expect(second).toBe(first);
		lazy.dispose();
	});

	// The re-check inherits the rule the first pass answers to: a pass that
	// throws owns the connection it was handed, because nothing caches it
	// afterwards and dispose() can no longer reach it.
	test.if(existsSync(PROCESS_DESCRIPTORS))(
		"a re-check that throws closes the connection and reopens on the next call",
		async () => {
			let now = 0;
			const lazy = new LazyCodeIndex(dir, () => now);
			await lazy.repository();
			dropFilesTable();
			now += RECHECK_AFTER_MS;

			await expect(lazy.repository()).rejects.toThrow(/no such table: files/);
			expect(codeDbDescriptors()).toBe(0);

			discardCodeDb();
			expect((await lazy.repository()).listFiles()).toHaveLength(1);
			lazy.dispose();
		},
	);

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

	test("concurrent access shares one reconcile and one connection", async () => {
		const lazy = new LazyCodeIndex(dir);

		const [first, second] = await Promise.all([
			lazy.repository(),
			lazy.repository(),
		]);

		expect(first).toBe(second);
		lazy.dispose();
	});

	test("a failed reconcile is not cached and the next access retries", async () => {
		writeFileSync(join(dir, ".cortex/code.db"), "not a sqlite database");
		const lazy = new LazyCodeIndex(dir);
		expect(lazy.repository()).rejects.toThrow();

		await Bun.sleep(0);
		rmSync(join(dir, ".cortex/code.db"));

		expect((await lazy.repository()).listFiles()).toHaveLength(1);
		lazy.dispose();
	});

	// The retry is the point: nothing holds the handle of a reconcile that
	// threw, so a connection left open there is one dispose() can never reach
	// and one more handle on every later call. Counting the handles on one file
	// is what /proc offers and macOS does not, so the measurement is Linux-only.
	test.if(existsSync(PROCESS_DESCRIPTORS))(
		"a reconcile that throws after opening closes its connection",
		async () => {
			const open = openCodeRepository(join(dir, ".cortex"));
			open.database.run("DROP TABLE files");
			expect(codeDbDescriptors()).toBeGreaterThan(0);
			open.database.close();
			const lazy = new LazyCodeIndex(dir);

			for (let attempt = 0; attempt < 8; attempt++) {
				await expect(lazy.repository()).rejects.toThrow(/no such table: files/);
			}

			expect(codeDbDescriptors()).toBe(0);
		},
	);

	test("dispose during a doomed reconcile leaves nothing pending", async () => {
		writeFileSync(join(dir, ".cortex/code.db"), "not a sqlite database");
		const lazy = new LazyCodeIndex(dir);
		const doomed = lazy.repository();
		lazy.dispose();

		expect(doomed).rejects.toThrow();
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
