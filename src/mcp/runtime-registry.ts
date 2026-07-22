import { resolve } from "node:path";
import { buildRuntimeAt, type CortexRuntime } from "@/app/runtime";
import { findNearestCortexRoot } from "@/storage/locate-store";

export type RuntimeResolution =
	| { ok: true; runtime: CortexRuntime }
	| { ok: false; guidance: string };

type DefaultProject = { root: string } | { guidance: string };

export class RuntimeRegistry {
	private readonly runtimes = new Map<string, Promise<CortexRuntime>>();

	private constructor(private readonly defaultProject: DefaultProject) {}

	static fromCwd(cwd: string): RuntimeRegistry {
		const start = resolve(cwd);
		const root = findNearestCortexRoot(start);
		return new RuntimeRegistry(
			root ? { root } : { guidance: noDefaultGuidance(start) },
		);
	}

	get hasDefaultProject(): boolean {
		return "root" in this.defaultProject;
	}

	async resolve(projectPath?: string): Promise<RuntimeResolution> {
		if (projectPath) return this.resolveExplicit(projectPath);
		if ("guidance" in this.defaultProject) {
			return { ok: false, guidance: this.defaultProject.guidance };
		}
		return { ok: true, runtime: await this.open(this.defaultProject.root) };
	}

	async dispose(): Promise<void> {
		const pending = [...this.runtimes.values()];
		this.runtimes.clear();
		for (const opened of pending) {
			(await opened.catch(() => null))?.dispose();
		}
	}

	// Re-resolve the store root on every call and cache by RESOLVED root only:
	// caching by input path would pin its first resolution for the server's
	// whole lifetime, missing a project that gains its own .cortex/ later.
	private async resolveExplicit(
		projectPath: string,
	): Promise<RuntimeResolution> {
		const root = findNearestCortexRoot(projectPath);
		if (!root) {
			return { ok: false, guidance: notInitializedGuidance(projectPath) };
		}
		return { ok: true, runtime: await this.open(root) };
	}

	private open(root: string): Promise<CortexRuntime> {
		const cached = this.runtimes.get(root);
		if (cached) return cached;
		const opening = buildRuntimeAt(root);
		this.runtimes.set(root, opening);
		opening.catch(() => this.runtimes.delete(root));
		return opening;
	}
}

function noDefaultGuidance(searchedFrom: string): string {
	return (
		"This Cortex server started outside any initialized project (no " +
		`.cortex/decisions.db found walking up from ${searchedFrom}), so there ` +
		"is no default project to fall back to. Pass the target project's " +
		"absolute path as projectPath — any directory inside it works. For a " +
		"project without a store, the user can run `cortex init` there to " +
		"enable it."
	);
}

function notInitializedGuidance(projectPath: string): string {
	return (
		`The project at ${projectPath} has no Cortex store (no ` +
		".cortex/decisions.db found walking up from it), so no decisions are " +
		"recorded there — a normal state, not a failure. Skip Cortex for that " +
		"project unless the user runs `cortex init` there; other initialized " +
		"projects can still be queried by passing their projectPath."
	);
}
