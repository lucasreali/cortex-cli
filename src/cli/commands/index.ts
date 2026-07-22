import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getRepoRoot } from "@/git";
import { CodeIndexer } from "@/indexer/code-indexer";
import { openCodeRepository } from "@/storage/code-db";

export async function runIndex(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { force: { type: "boolean", default: false } },
	});
	const root = getRepoRoot(cwd) ?? resolve(cwd);
	if (!existsSync(join(root, ".cortex", "decisions.db"))) {
		console.error("Cortex is not initialized here. Run: cortex init");
		return 1;
	}
	const { database, repository } = openCodeRepository(join(root, ".cortex"));
	try {
		const indexer = await CodeIndexer.create(root, repository);
		const started = performance.now();
		const report = await indexer.run({ force: values.force });
		const elapsed = Math.round(performance.now() - started);
		console.log(
			`Indexed ${report.indexed} file(s) (${report.mode}), ` +
				`${report.unchanged} unchanged, ${report.removed} removed in ${elapsed} ms.`,
		);
		return 0;
	} finally {
		database.close();
	}
}
