import { homedir } from "node:os";
import { basename, join } from "node:path";
import { writeAtomically } from "@/support/atomic-write";
import { sha256Hex } from "@/support/hash";

export interface GrammarSource {
	url: string;
	sha256: string;
	cacheDir: string;
}

const DOWNLOAD_TIMEOUT_MS = 60_000;

// Official tree-sitter-typescript release; the tree-sitter-wasms package was
// discarded (0.20-era dylink format, incompatible with web-tree-sitter 0.26).
const TSX_GRAMMAR: GrammarSource = {
	url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
	sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
	cacheDir: join(homedir(), ".cortex", "grammars"),
};

export async function ensureGrammar(
	source: GrammarSource = TSX_GRAMMAR,
): Promise<string> {
	const path = join(source.cacheDir, basename(source.url));
	if (await matchesHash(path, source.sha256)) return path;
	await writeAtomically(path, await verifiedBytes(source));
	return path;
}

async function matchesHash(path: string, sha256: string): Promise<boolean> {
	const file = Bun.file(path);
	if (!(await file.exists())) return false;
	return sha256Hex(new Uint8Array(await file.arrayBuffer())) === sha256;
}

// Verified before it is published under the cached name: a tampered or
// truncated download never becomes a file another process could read.
async function verifiedBytes(source: GrammarSource): Promise<Uint8Array> {
	const response = await fetch(source.url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(
			`grammar download failed: HTTP ${response.status} (${source.url})`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (sha256Hex(bytes) === source.sha256) return bytes;
	throw new Error(`grammar sha256 mismatch after download: ${source.url}`);
}
