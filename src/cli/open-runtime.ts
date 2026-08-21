import { buildRuntime, type CortexRuntime } from "@/app/runtime";
import { getRepoRoot } from "@/git";
import { registerProject } from "@/storage/project-registry";
import { ProjectRoot } from "@/storage/project-root";
import { errnoCode } from "@/support/errors";
import { reportFailure } from "./error-output";

export function projectRootFor(cwd: string): ProjectRoot {
	return ProjectRoot.at(getRepoRoot(cwd) ?? cwd);
}

export function requireInitialized(cwd: string): ProjectRoot | null {
	const project = projectRootFor(cwd);
	if (project.isInitialized()) return project;
	reportFailure("Cortex is not initialized here — run: cortex init");
	return null;
}

export async function withRuntime(
	cwd: string,
	use: (runtime: CortexRuntime) => Promise<number>,
): Promise<number> {
	const project = requireInitialized(cwd);
	if (!project) return 1;
	const runtime = await openRuntime(cwd, project);
	if (!runtime) return 1;
	runtime.decisions.ensure();
	registerProject(runtime.repoRoot, runtime.projectCanonicalId);
	try {
		return await use(runtime);
	} finally {
		runtime.dispose();
	}
}

// `decisions.db` is a derived cache and the decision files are the product, so
// a store SQLite refuses to open is a recoverable state with a one-line remedy
// — not the bare "file is not a database" every command used to die on, which
// named neither the file nor the way back.
async function openRuntime(
	cwd: string,
	project: ProjectRoot,
): Promise<CortexRuntime | null> {
	try {
		return await buildRuntime(cwd);
	} catch (error) {
		if (errnoCode(error) !== "SQLITE_NOTADB") throw error;
		reportFailure(
			`${project.decisionsDbPath} is not a database — it is a rebuildable ` +
				"cache: delete it and run `cortex sync` to rebuild it from " +
				".cortex/decisions/",
		);
		return null;
	}
}
