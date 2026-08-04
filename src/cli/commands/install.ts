import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { confirmInteractive } from "@/cli/confirm";
import { failure, style, success, warning } from "@/cli/style";
import { usageError } from "@/cli/usage";
import { RUNS_FROM_COMPILED_BINARY } from "@/embedding/subprocess-command";
import type { UpsertOutcome } from "@/install/json-mcp";
import { resolveServerSpec } from "@/install/server-spec";
import {
	ALL_TARGETS,
	type HarnessTarget,
	resolveTargets,
} from "@/install/targets";
import { currentBinaryPath } from "@/release/installer";

export async function runInstall(args: string[]): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			yes: { type: "boolean", default: false },
			target: { type: "string", default: "auto" },
		},
	});
	const home = homedir();
	const resolution = resolveTargets(values.target, home);
	if ("error" in resolution) {
		console.error(failure(resolution.error));
		return usageError("install");
	}
	if (resolution.targets.length === 0) {
		const known = ALL_TARGETS.map((target) => target.displayName).join(", ");
		console.log(warning(`no supported coding agents detected (${known})`));
		return 0;
	}
	return registerTargets(resolution.targets, home, values.yes);
}

async function registerTargets(
	targets: HarnessTarget[],
	home: string,
	assumeYes: boolean,
): Promise<number> {
	const server = resolveServerSpec({
		compiled: RUNS_FROM_COMPILED_BINARY,
		binaryPath: currentBinaryPath(),
		onPath: Bun.which("cortex"),
	});
	if (server.warning) console.log(warning(server.warning));

	let unreadable = false;
	let registered = 0;
	for (const target of targets) {
		const path = tildify(target.configPath(home), home);
		if (!assumeYes && !confirmAccepts(target, path)) continue;
		const outcome = await target.register(home, server.spec);
		if (outcome.action === "skipped-unreadable") unreadable = true;
		else registered += 1;
		report(target, outcome, home);
	}
	if (registered === 0 && !assumeYes && !process.stdin.isTTY) {
		console.log(warning("non-interactive: nothing written — rerun with --yes"));
		return 1;
	}
	if (registered > 0) {
		console.log(
			style.dim(
				"Restart your agent sessions to load the server, then run " +
					"`cortex init` in each repository.",
			),
		);
	}
	return unreadable ? 1 : 0;
}

function confirmAccepts(target: HarnessTarget, path: string): boolean {
	return confirmInteractive(
		`Register the cortex MCP server for ${target.displayName} (${path})?`,
	);
}

function report(
	target: HarnessTarget,
	outcome: UpsertOutcome,
	home: string,
): void {
	const path = tildify(outcome.path, home);
	if (outcome.action === "skipped-unreadable") {
		console.error(
			failure(`${path} is not valid JSON — fix or remove it, then rerun`),
		);
		return;
	}
	const verb = {
		created: "registered",
		updated: "updated",
		unchanged: "already registered",
	}[outcome.action];
	console.log(success(`${target.displayName} — ${verb} (${path})`));
}

function tildify(path: string, home: string): string {
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}
