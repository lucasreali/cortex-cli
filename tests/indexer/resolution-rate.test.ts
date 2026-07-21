import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getRepoRoot } from "@/git";
import { ensureGrammar } from "@/indexer/grammar";
import { ImportResolver } from "@/indexer/import-resolver";
import { listSourceFiles } from "@/indexer/source-walker";
import { TsconfigAliases } from "@/indexer/tsconfig-aliases";
import { TsxExtractor } from "@/indexer/tsx-extractor";

describe("resolution rate on this repository", () => {
	test("resolvable-intent imports resolve at ≥ 85%", async () => {
		const root = getRepoRoot(process.cwd()) as string;
		const files = listSourceFiles(root);
		const extractor = await TsxExtractor.create(await ensureGrammar());
		const resolver = await ImportResolver.create(
			root,
			files.map((file) => file.path),
		);
		const aliases = await TsconfigAliases.load(root);

		let candidates = 0;
		let resolved = 0;
		for (const file of files) {
			const source = await Bun.file(join(root, file.path)).text();
			for (const specifier of extractor.extract(source).imports) {
				if (!isResolvableIntent(aliases, specifier)) continue;
				candidates++;
				if (resolver.resolve(file.path, specifier).toPath) resolved++;
			}
		}

		const rate = resolved / candidates;
		console.log(
			`import resolution rate: ${resolved}/${candidates} = ${(rate * 100).toFixed(1)}%`,
		);
		expect(candidates).toBeGreaterThan(20);
		expect(rate).toBeGreaterThanOrEqual(0.85);
	});
});

function isResolvableIntent(
	aliases: TsconfigAliases,
	specifier: string,
): boolean {
	if (specifier.startsWith("./") || specifier.startsWith("../")) return true;
	return aliases.expand(specifier).length > 0;
}
