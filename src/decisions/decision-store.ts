import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionFile } from "@/domain";
import { DECISIONS_DIRECTORY } from "@/storage/project-root";
import { stagingSuffix, writeAtomicallySync } from "@/support/atomic-write";
import { errnoCode, errorMessage } from "@/support/errors";
import {
	type DecisionFileParse,
	formatDecisionFile,
	parseDecisionFile,
} from "./decision-file";

const EXTENSION = ".md";
// Lowercase only: `Bun.randomUUIDv7` writes lowercase, and a case-insensitive
// match would make `<ID>.MD` and `<id>.md` the same decision on macOS and
// Windows and two decisions on Linux. Refusing the spelling reports it instead.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UnusableDecisionFile {
	name: string;
	reason: string;
}

// A directory this process cannot read is not an empty branch: answering with
// the empty listing would retire every decision the store holds, so the state
// travels to the caller instead of being flattened into one.
export interface DecisionIndex {
	ids: string[];
	unusable: UnusableDecisionFile[];
}

export type DecisionListing =
	| ({ ok: true } & DecisionIndex)
	| { ok: false; reason: string };

// The versioned half of the store: a flat directory of markdown files, one per
// decision, that git merges on its own. Nothing here reads or writes SQLite.
export class DecisionStore {
	private constructor(readonly directory: string) {}

	static at(cortexDir: string): DecisionStore {
		return new DecisionStore(join(cortexDir, DECISIONS_DIRECTORY));
	}

	list(): DecisionListing {
		const read = this.names();
		if (!read.ok) return read;
		const names = [...read.names].sort();
		return {
			ok: true,
			ids: names.filter(isDecisionFileName).map(basename),
			unusable: names.flatMap(unusableReason),
		};
	}

	read(id: string): DecisionFileParse {
		const source = readText(this.pathFor(id));
		if (!source.ok) return source;
		return parseDecisionFile(id, source.text);
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
	private names(): NameListing {
		try {
			return { ok: true, names: readdirSync(this.directory) };
		} catch (error) {
			if (errnoCode(error) === "ENOENT") return { ok: true, names: [] };
			return { ok: false, reason: errorMessage(error) };
		}
	}
}

type NameListing =
	| { ok: true; names: string[] }
	| { ok: false; reason: string };

function basename(name: string): string {
	return name.slice(0, -EXTENSION.length);
}

function isDecisionFileName(name: string): boolean {
	return name.endsWith(EXTENSION) && UUID.test(basename(name));
}

// Both shapes are invisible to loading, and both are reported rather than
// skipped: a `.md` whose name is not an id can never be found by any lookup, so
// a typo must not silently hide a decision, and a staging file is what a crash
// between the write and the rename leaves behind — nothing else ever collects
// it, so it would sit in a committed directory forever.
function unusableReason(name: string): UnusableDecisionFile[] {
	if (isDecisionFileName(name)) return [];
	if (name.endsWith(EXTENSION)) {
		return [{ name, reason: "filename is not a decision id" }];
	}
	if (name.endsWith(stagingSuffix())) {
		return [{ name, reason: "leftover from an interrupted write — delete it" }];
	}
	return [];
}

type TextRead = { ok: true; text: string } | { ok: false; reason: string };

// Present-but-unusable is never absent and never fatal: every command runs a
// reconcile, so one `chmod 000` file used to take `log`, `search`, `doctor` and
// every MCP tool down with it — and the git hook, which swallows the error, just
// stopped indexing. The kind is checked before the bytes because a decision file
// is only ever a regular file: a directory named `<id>.md` reads as EISDIR, and
// a fifo would block the reconcile for as long as nobody writes to it.
function readText(path: string): TextRead {
	try {
		if (!statSync(path).isFile()) {
			return { ok: false, reason: "not a regular file" };
		}
		return { ok: true, text: readFileSync(path, "utf8") };
	} catch (error) {
		if (errnoCode(error) === "ENOENT") {
			return { ok: false, reason: "file not found" };
		}
		return { ok: false, reason: errorMessage(error) };
	}
}
