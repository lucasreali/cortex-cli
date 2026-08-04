import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionFile } from "@/domain";
import { writeAtomicallySync } from "@/support/atomic-write";
import { errnoCode } from "@/support/errors";
import {
	type DecisionFileParse,
	formatDecisionFile,
	parseDecisionFile,
} from "./decision-file";

export const DECISIONS_DIRECTORY = "decisions";

const EXTENSION = ".md";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The versioned half of the store: a flat directory of markdown files, one per
// decision, that git merges on its own. Nothing here reads or writes SQLite.
export class DecisionStore {
	private constructor(readonly directory: string) {}

	static at(cortexDir: string): DecisionStore {
		return new DecisionStore(join(cortexDir, DECISIONS_DIRECTORY));
	}

	listIds(): string[] {
		return this.names()
			.filter((name) => UUID.test(basename(name)))
			.map(basename)
			.sort();
	}

	// A .md file whose name is not an id can never be found by any lookup, so
	// it is reported rather than skipped: a typo must not silently hide a
	// decision.
	listUnparseableNames(): string[] {
		return this.names()
			.filter((name) => !UUID.test(basename(name)))
			.sort();
	}

	read(id: string): DecisionFileParse {
		const source = readTextOrNull(this.pathFor(id));
		if (source === null) return { ok: false, reason: "file not found" };
		return parseDecisionFile(id, source);
	}

	write(file: DecisionFile): void {
		const path = this.pathFor(file.id);
		mkdirSync(dirname(path), { recursive: true });
		writeAtomicallySync(path, formatDecisionFile(file));
	}

	pathFor(id: string): string {
		return join(this.directory, `${id}${EXTENSION}`);
	}

	// A branch with no decisions carries no directory — git does not track
	// empty ones — so a missing directory is the empty listing, not an error.
	private names(): string[] {
		try {
			return readdirSync(this.directory).filter((name) =>
				name.endsWith(EXTENSION),
			);
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return [];
			throw error;
		}
	}
}

function basename(name: string): string {
	return name.slice(0, -EXTENSION.length);
}

function readTextOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return null;
		throw error;
	}
}
