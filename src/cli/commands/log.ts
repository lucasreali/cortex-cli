import { parseArgs } from "node:util";
import { printJson } from "@/cli/json";
import { openInitializedRuntime } from "@/cli/open-runtime";
import { style } from "@/cli/style";
import type { Decision } from "@/domain";

export async function runLog(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			module: { type: "string" },
			since: { type: "string" },
			json: { type: "boolean", default: false },
		},
	});
	const runtime = await openInitializedRuntime(cwd);
	if (!runtime) return 1;
	try {
		const decisions = runtime.nodes.listActive({
			module: values.module,
			sinceSha: values.since,
		});
		if (values.json) {
			printJson(decisions);
			return 0;
		}
		if (decisions.length === 0) {
			console.log(style.dim("No active decisions."));
			return 0;
		}
		for (const decision of decisions) {
			console.log(formatLine(decision));
		}
		return 0;
	} finally {
		runtime.dispose();
	}
}

function formatLine(decision: Decision): string {
	const date = style.dim(decision.createdAt.slice(0, 10));
	const module = decision.module
		? `${style.cyan(`[${decision.module}]`)} `
		: "";
	return `${date}  ${module}${decision.title}  ${style.dim(decision.id)}`;
}
