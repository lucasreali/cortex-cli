import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export interface GrammarSource {
	url: string;
	sha256: string;
	cacheDir: string;
}

// Official tree-sitter-typescript release; the tree-sitter-wasms package was
// discarded in phase 0 (0.20-era dylink format, incompatible with
// web-tree-sitter 0.26).
export const TSX_GRAMMAR: GrammarSource = {
	url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
	sha256: "79e5da75ea62855a0cd67177685f0164eac87d5f630b3cbe1e0a099751ad30f8",
	cacheDir: join(homedir(), ".cortex", "grammars"),
};

export async function ensureGrammar(
	source: GrammarSource = TSX_GRAMMAR,
): Promise<string> {
	const path = join(source.cacheDir, basename(source.url));
	if (await matchesHash(path, source.sha256)) return path;
	await download(source.url, path);
	if (await matchesHash(path, source.sha256)) return path;
	unlinkSync(path);
	throw new Error(`grammar sha256 mismatch after download: ${source.url}`);
}

async function matchesHash(path: string, sha256: string): Promise<boolean> {
	const file = Bun.file(path);
	if (!(await file.exists())) return false;
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(await file.arrayBuffer());
	return hasher.digest("hex") === sha256;
}

async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`grammar download failed: HTTP ${response.status} (${url})`,
		);
	}
	await Bun.write(path, response);
}
