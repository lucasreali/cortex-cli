import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeAtomicallySync } from "./atomic-write";

// A newline-delimited file that is only ever appended to, and occasionally
// rewritten shorter. Both sidecar logs are this shape, and both need the same
// two properties from it: an append that never throws, and a compaction that
// does not swallow what another process wrote while it ran.
export class AppendOnlyLog {
	constructor(private readonly path: string) {}

	read(): string {
		return this.readBytes().toString("utf8");
	}

	sizeInBytes(): number {
		try {
			return statSync(this.path).size;
		} catch {
			return 0;
		}
	}

	// Reports whether the bytes landed rather than throwing: every caller here
	// would rather lose a line of a rebuildable cache than fail the query that
	// produced it.
	append(text: string): boolean {
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			appendFileSync(this.path, text);
			return true;
		} catch {
			return false;
		}
	}

	// Rewrites the log as `shorten` sees it, then puts back whatever arrived
	// while that ran: `shorten` reads a snapshot, and between that read and the
	// rename another process may have appended lines this one never saw. Merging
	// the tail back is what keeps compaction from being how they disappear.
	//
	// It does not close the window entirely — a line appended after the tail is
	// read and before the rename is still lost — and no lock is taken to close
	// it. A lock here would have to be held by the appenders too, which is the
	// cost of a file open, an exclusive create and an unlink on the query path,
	// and it would trade this window for a stale lock disabling compaction
	// outright. For a local cache that costs nothing to rebuild, a window of
	// microseconds is the better bargain; anything that must not be lost belongs
	// in the store, not here.
	compact(shorten: (text: string) => string): void {
		const before = this.readBytes();
		const text = before.toString("utf8");
		const shortened = shorten(text);
		if (shortened === text) return;
		const tail = this.readBytes().subarray(before.length).toString("utf8");
		try {
			writeAtomicallySync(this.path, shortened + tail);
		} catch {}
	}

	private readBytes(): Buffer {
		try {
			return readFileSync(this.path);
		} catch {
			return Buffer.alloc(0);
		}
	}
}
