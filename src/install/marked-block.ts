export type BlockUpsert =
	| {
			content: string;
			action: "created" | "appended" | "updated" | "unchanged";
	  }
	| { action: "skipped-malformed" };

export type BlockRemoval =
	| { content: string; action: "removed"; leavesRemainderEmpty: boolean }
	| { action: "absent" }
	| { action: "skipped-malformed" };

type BlockBounds =
	| { found: true; start: number; stop: number }
	| { found: false; reason: "missing" | "malformed" };

// One fence, two consumers: the instruction block cortex writes into CLAUDE.md
// and the shell block it writes into a git hook. `remove` is the exact inverse
// of `upsert`'s append, so install → uninstall → install is byte-stable and a
// file the user owns comes back unchanged.
export class MarkedBlock {
	constructor(
		private readonly begin: string,
		private readonly end: string,
	) {}

	fence(body: string): string {
		return `${this.begin}\n${body}\n${this.end}`;
	}

	upsert(existing: string | null, body: string): BlockUpsert {
		const block = this.fence(body);
		if (existing === null) return { content: `${block}\n`, action: "created" };
		const bounds = this.bounds(existing);
		if (!bounds.found && bounds.reason === "malformed") {
			return { action: "skipped-malformed" };
		}
		if (!bounds.found) return append(existing, block);
		const content =
			existing.slice(0, bounds.start) + block + existing.slice(bounds.stop);
		if (content === existing) return { content, action: "unchanged" };
		return { content, action: "updated" };
	}

	remove(existing: string | null): BlockRemoval {
		if (existing === null) return { action: "absent" };
		const bounds = this.bounds(existing);
		if (!bounds.found) {
			return {
				action: bounds.reason === "malformed" ? "skipped-malformed" : "absent",
			};
		}
		const content = rejoin(
			existing.slice(0, bounds.start),
			existing.slice(bounds.stop),
		);
		return { content, action: "removed", leavesRemainderEmpty: content === "" };
	}

	private bounds(existing: string): BlockBounds {
		const start = existing.indexOf(this.begin);
		if (start === -1) return { found: false, reason: "missing" };
		const endsAt = existing.indexOf(this.end, start);
		if (endsAt === -1) return { found: false, reason: "malformed" };
		return { found: true, start, stop: endsAt + this.end.length };
	}
}

function append(existing: string, block: string): BlockUpsert {
	const body = existing.trimEnd();
	if (body === "") return { content: `${block}\n`, action: "created" };
	return { content: `${body}\n\n${block}\n`, action: "appended" };
}

function rejoin(before: string, after: string): string {
	const head = before.trimEnd();
	const tail = after.trimStart();
	if (head === "") return terminate(tail);
	if (tail === "") return terminate(head);
	return terminate(`${head}\n\n${tail}`);
}

function terminate(text: string): string {
	if (text === "" || text.endsWith("\n")) return text;
	return `${text}\n`;
}
