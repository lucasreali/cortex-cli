import { buildRuntime, type CortexRuntime } from "@/app/runtime";
import { getRepoRoot } from "@/git";
import { registerProject } from "@/storage/project-registry";
import { ProjectRoot } from "@/storage/project-root";
import { failure } from "./style";

export function projectRootFor(cwd: string): ProjectRoot {
	return ProjectRoot.at(getRepoRoot(cwd) ?? cwd);
}

export function requireInitialized(cwd: string): ProjectRoot | null {
	const project = projectRootFor(cwd);
	if (project.isInitialized()) return project;
	console.error(failure("Cortex is not initialized here — run: cortex init"));
	return null;
}

export async function withRuntime(
	cwd: string,
	use: (runtime: CortexRuntime) => Promise<number>,
): Promise<number> {
	if (!requireInitialized(cwd)) return 1;
	const runtime = await buildRuntime(cwd);
	runtime.decisions.ensure();
	registerProject(runtime.repoRoot, runtime.projectCanonicalId);
	try {
		return await use(runtime);
	} finally {
		runtime.dispose();
	}
}
