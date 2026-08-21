import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { type Consent, consent, refusal } from "@/cli/confirm";
import { reportFailure, usageError } from "@/cli/error-output";
import { style, success, warning } from "@/cli/style";
import { RUNS_FROM_COMPILED_BINARY } from "@/embedding/subprocess-command";
import type { UpsertOutcome } from "@/install/json-mcp";
import { resolveServerSpec } from "@/install/server-spec";
import {
	ALL_TARGETS,
	type HarnessTarget,
	resolveTargets,
} from "@/install/targets";
import { currentBinaryPath } from "@/release/installer";
import { tildify } from "@/support/tildify";
import { installGitHooks, removeGitHooks } from "./install-git-hooks";

export async function runInstall(args: string[], cwd: string): Promise<number> {
	const { values } = parseArgs({
		args,
		options: {
			yes: { type: "boolean", default: false },
			target: { type: "string" },
			"git-hooks": { type: "boolean", default: false },
			uninstall: { type: "boolean", default: false },
		},
	});
	// Registering the MCP server is user-scoped and hooks are repo-scoped, so
	// --git-hooks is exclusive: a bare `cortex install` must keep writing no
	// repository files, and must keep working outside a git repository. Being
	// exclusive is why --target has to be refused rather than ignored — a flag
	// silently discarded is a flag the user believes was honoured.
	if (values["git-hooks"]) {
		if (values.target !== undefined) {
			reportFailure("--target selects coding agents, not git hooks");
			return usageError("install");
		}
		return values.uninstall
			? removeGitHooks(cwd, values.yes)
			: installGitHooks(cwd, values.yes);
	}
	if (values.uninstall) {
		reportFailure("--uninstall only applies to --git-hooks");
		return usageError("install");
	}
	const home = homedir();
	const resolution = resolveTargets(values.target ?? "auto", home);
	if ("error" in resolution) {
		reportFailure(resolution.error);
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

	let skipped = false;
	let registered = 0;
	let withheld: Consent | null = null;
	for (const target of targets) {
		const path = tildify(target.configPath(home), home);
		const consented = consent(confirmQuestion(target, path), assumeYes);
		if (consented !== "granted") {
			withheld = consented;
			continue;
		}
		const outcome = await target.register(home, server.spec);
		if (outcome.action === "skipped") skipped = true;
		else registered += 1;
		report(target, outcome, home);
	}
	if (registered === 0 && withheld) return refusal(withheld);
	if (registered > 0) {
		console.log(
			style.dim(
				"Restart your agent sessions to load the server, then run " +
					"`cortex init` in each repository.",
			),
		);
	}
	return skipped ? 1 : 0;
}

function confirmQuestion(target: HarnessTarget, path: string): string {
	return `Register the cortex MCP server for ${target.displayName} (${path})?`;
}

function report(
	target: HarnessTarget,
	outcome: UpsertOutcome,
	home: string,
): void {
	const path = tildify(outcome.path, home);
	if (outcome.action === "skipped") {
		reportFailure(`${path} ${outcome.reason}`);
		return;
	}
	const verb = {
		created: "registered",
		updated: "updated",
		unchanged: "already registered",
	}[outcome.action];
	console.log(success(`${target.displayName} — ${verb} (${path})`));
}
