import { parseArgs } from "node:util";
import { printJson } from "@/cli/json";
import { withRuntime } from "@/cli/open-runtime";
import { style, success, warning } from "@/cli/style";
import type { ReconcileReport } from "@/decisions/reconcile";

export async function runSync(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: { json: { type: "boolean", default: false } },
	});
	return withRuntime(cwd, async (runtime) => {
		const report = runtime.decisions.resync();
		if (values.json) {
			printJson(report);
			return 0;
		}
		render(report);
		return 0;
	});
}

// A dangling link or an unreadable file is a finding for doctor, not a reason
// to fail: the reconcile itself succeeded, and the store reflects the branch.
function render(report: ReconcileReport): void {
	for (const line of changes(report)) {
		console.log(line);
	}
	for (const entry of report.malformed) {
		console.log(warning(`could not read ${entry.name}: ${entry.reason}`));
	}
	for (const edge of report.dangling) {
		console.log(
			warning(`link dropped, target unknown: ${edge.kind} → ${edge.to}`),
		);
	}
}

function changes(report: ReconcileReport): string[] {
	const counted = [
		count("imported", report.imported.length),
		count("no longer on this branch", report.absent.length),
		count("back on this branch", report.restored.length),
	].filter((line) => line !== null);
	if (counted.length === 0) {
		return [style.dim("Already in sync with this branch.")];
	}
	return counted.map(success);
}

function count(label: string, total: number): string | null {
	if (total === 0) return null;
	return `${total} decision(s) ${label}`;
}
