import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { getRepoRoot } from "@/git";
import { CodeIndexer } from "@/indexer/code-indexer";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";

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
	const database = openCodeDb(join(root, ".cortex"));
	try {
		migrateCode(database);
		const indexer = await CodeIndexer.create(
			root,
			new CodeRepository(database),
		);
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
