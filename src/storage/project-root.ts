import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CORTEX_DIRECTORY = ".cortex";
export const DECISIONS_DIRECTORY = "decisions";

// The project a store belongs to, so a repo root and a .cortex directory stop
// being two interchangeable strings: buildRuntime takes one and buildRuntimeAt
// the other, and nothing but this type keeps callers from swapping them.
export class ProjectRoot {
	private constructor(readonly directory: string) {}

	static at(directory: string): ProjectRoot {
		return new ProjectRoot(resolve(directory));
	}

	static nearest(startDir: string): ProjectRoot | null {
		return walkUp(resolve(startDir));
	}

	get cortexDir(): string {
		return join(this.directory, CORTEX_DIRECTORY);
	}

	get decisionsDbPath(): string {
		return join(this.cortexDir, "decisions.db");
	}

	get codeDbPath(): string {
		return join(this.cortexDir, "code.db");
	}

	get decisionsPath(): string {
		return join(this.cortexDir, DECISIONS_DIRECTORY);
	}

	// A fresh clone carries the decision files and none of the derived caches,
	// and it is every bit as initialized as the machine it was cloned from —
	// the first command rebuilds the database from what git brought.
	isInitialized(): boolean {
		return existsSync(this.decisionsDbPath) || existsSync(this.decisionsPath);
	}
}

function walkUp(directory: string): ProjectRoot | null {
	if (ProjectRoot.at(directory).isInitialized()) {
		return ProjectRoot.at(directory);
	}
	const parent = dirname(directory);
	if (parent === directory) return null;
	return walkUp(parent);
}
