import { ProjectRoot } from "./project-root";

export function findNearestCortexRoot(startDir: string): string | null {
	return ProjectRoot.nearest(startDir)?.directory ?? null;
}
