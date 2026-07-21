import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureGrammar, type GrammarSource } from "@/indexer/grammar";

const GOOD_BYTES = new TextEncoder().encode("pretend-wasm-grammar");

function sha256(bytes: Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(bytes);
	return hasher.digest("hex");
}

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let served: Uint8Array | null;
let hits: number;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-grammar-"));
	served = GOOD_BYTES;
	hits = 0;
	server = Bun.serve({
		port: 0,
		fetch() {
			hits++;
			if (!served) return new Response("missing", { status: 404 });
			return new Response(served);
		},
	});
});

afterEach(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

function source(overrides: Partial<GrammarSource> = {}): GrammarSource {
	return {
		url: `http://localhost:${server.port}/tree-sitter-tsx.wasm`,
		sha256: sha256(GOOD_BYTES),
		cacheDir: dir,
		...overrides,
	};
}

describe("ensureGrammar", () => {
	test("downloads and caches the grammar on first use", async () => {
		const path = await ensureGrammar(source());
		expect(path).toBe(join(dir, "tree-sitter-tsx.wasm"));
		expect(new Uint8Array(await Bun.file(path).arrayBuffer())).toEqual(
			GOOD_BYTES,
		);
		expect(hits).toBe(1);
	});

	test("a valid cached grammar is reused without any request", async () => {
		writeFileSync(join(dir, "tree-sitter-tsx.wasm"), GOOD_BYTES);
		await ensureGrammar(source());
		expect(hits).toBe(0);
	});

	test("a corrupted cached grammar is re-downloaded", async () => {
		writeFileSync(join(dir, "tree-sitter-tsx.wasm"), "corrupted");
		const path = await ensureGrammar(source());
		expect(hits).toBe(1);
		expect(await Bun.file(path).text()).toBe("pretend-wasm-grammar");
	});

	test("a download that fails the hash check is discarded", async () => {
		served = new TextEncoder().encode("tampered");
		await expect(ensureGrammar(source())).rejects.toThrow("sha256 mismatch");
		expect(await Bun.file(join(dir, "tree-sitter-tsx.wasm")).exists()).toBe(
			false,
		);
	});

	test("an http error surfaces as a failed download", async () => {
		served = null;
		await expect(ensureGrammar(source())).rejects.toThrow("HTTP 404");
	});
});
