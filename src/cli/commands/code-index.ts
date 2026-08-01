import { parseArgs } from "node:util";
import { requireInitialized } from "@/cli/open-runtime";
import { success } from "@/cli/style";
import { CodeIndexer } from "@/indexer/code-indexer";
import { openCodeRepository } from "@/storage/code-db";

export async function runIndex(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { force: { type: "boolean", default: false } },
	});
	const project = requireInitialized(cwd);
	if (!project) return 1;
	const { database, repository } = openCodeRepository(project.cortexDir);
	try {
		const indexer = await CodeIndexer.create(project.directory, repository);
		const started = performance.now();
		const report = await indexer.run({ force: values.force });
		const elapsed = Math.round(performance.now() - started);
		console.log(
			success(
				`Indexed ${report.indexed} file(s) (${report.mode}), ` +
					`${report.unchanged} unchanged, ${report.removed} removed in ${elapsed} ms.`,
			),
		);
		return 0;
	} finally {
		database.close();
	}
}
