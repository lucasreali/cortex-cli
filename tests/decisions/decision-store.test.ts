import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionStore } from "@/decisions/decision-store";
import type { DecisionFile } from "@/domain";
import { sha256Hex } from "@/support/hash";

const ID = "019f6dc3-e77a-7000-8000-000000000000";

let dir: string;
let store: DecisionStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-decision-store-"));
	store = DecisionStore.at(dir);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function decisionFile(id = ID): DecisionFile {
	return {
		id,
		title: "Adotar RRF entre BM25 e cosseno",
		body: "RRF k=60 sobre as duas pernas.",
		keywords: ["busca", "search", "rrf", "bm25", "embeddings"],
		module: null,
		replaces: null,
		archives: null,
		dependsOn: [],
		conflictsWith: [],
		anchors: [],
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		createdAt: "2026-07-22T14:03:11.204Z",
	};
}

function touch(name: string, contents = "whatever\n"): void {
	writeFileSync(join(store.directory, name), contents);
}

describe("DecisionStore on a branch that carries no decisions", () => {
	test("lists nothing and does not create the directory", () => {
		expect(store.list()).toEqual({ ok: true, ids: [], unusable: [] });
		expect(existsSync(store.directory)).toBe(false);
	});

	test("reading an id that has no file is a parse failure, not a throw", () => {
		expect(store.read(ID)).toEqual({ ok: false, reason: "file not found" });
	});
});

describe("DecisionStore listing", () => {
	beforeEach(() => {
		store.write(decisionFile());
	});

	test("sorts ids and ignores everything that is not a decision file", () => {
		const older = "019f0000-0000-7000-8000-000000000001";
		store.write(decisionFile(older));
		touch("README.txt");
		touch(".gitkeep");

		expect(store.list()).toEqual({
			ok: true,
			ids: [older, ID],
			unusable: [],
		});
	});

	test("reports a .md file whose name could never be looked up", () => {
		touch("notes.md");
		touch("019f6dc3-e77a-7000-8000.md");

		expect(store.list()).toEqual({
			ok: true,
			ids: [ID],
			unusable: [
				{
					name: "019f6dc3-e77a-7000-8000.md",
					reason: "filename is not a decision id",
				},
				{ name: "notes.md", reason: "filename is not a decision id" },
			],
		});
	});
});

describe("DecisionStore.write", () => {
	test("creates the directory, round-trips, and leaves no staging file", () => {
		const file = decisionFile();
		store.write(file);

		expect(store.read(ID)).toEqual({
			ok: true,
			file,
			contentSha: sha256Hex(readFileSync(store.pathFor(ID), "utf8")),
		});
		expect(readdirSync(store.directory)).toEqual([`${ID}.md`]);
		expect(store.pathFor(ID)).toBe(join(store.directory, `${ID}.md`));
	});

	test("overwriting replaces the file rather than appending to it", () => {
		store.write(decisionFile());
		store.write({ ...decisionFile(), title: "Outro título por completo" });

		const parsed = store.read(ID);
		expect(parsed.ok && parsed.file.title).toBe("Outro título por completo");
		expect(readdirSync(store.directory)).toEqual([`${ID}.md`]);
	});

	test("a file that does not parse reports why, and does not vanish", () => {
		store.write(decisionFile());
		touch(`${ID}.md`, "sem frontmatter nenhum\n");

		expect(store.list()).toEqual({ ok: true, ids: [ID], unusable: [] });
		expect(store.read(ID)).toEqual({
			ok: false,
			reason: "missing frontmatter fence",
		});
	});
});

// Everything a reconcile can meet that is not a readable decision file. None of
// it may throw: `DecisionSync.ensure()` runs on every command, and the git hook
// swallows what it raises — one unreadable file used to stop post-commit
// indexing with no output at all.
describe("DecisionStore on what is not a readable decision file", () => {
	test("a directory named like a decision reports, and never throws", () => {
		mkdirSync(join(store.directory, `${ID}.md`), { recursive: true });

		expect(store.read(ID)).toEqual({
			ok: false,
			reason: "not a regular file",
		});
	});

	test("a file this process cannot read reports why", () => {
		store.write(decisionFile());
		chmodSync(store.pathFor(ID), 0o000);

		const parse = store.read(ID);

		expect(parse.ok).toBe(false);
		expect(parse.ok || parse.reason).toContain("EACCES");
	});

	test("a staging file an interrupted write left behind is named", () => {
		store.write(decisionFile());
		touch(`${ID}.md.4242.partial`);

		expect(store.list()).toEqual({
			ok: true,
			ids: [ID],
			unusable: [
				{
					name: `${ID}.md.4242.partial`,
					reason: "leftover from an interrupted write — delete it",
				},
			],
		});
	});

	// The same id in two spellings is one decision on macOS and two on Linux,
	// so the spelling cortex never writes is reported rather than accepted.
	test("an uppercase id is not an id", () => {
		mkdirSync(store.directory, { recursive: true });
		touch(`${ID.toUpperCase()}.md`);

		expect(store.list()).toEqual({
			ok: true,
			ids: [],
			unusable: [
				{
					name: `${ID.toUpperCase()}.md`,
					reason: "filename is not a decision id",
				},
			],
		});
	});

	// Answering with the empty listing would retire every decision the store
	// holds, which is the one outcome an unreadable directory must not produce.
	test("a directory that cannot be listed is a reason, not an empty branch", () => {
		store.write(decisionFile());
		chmodSync(store.directory, 0o000);
		try {
			const listing = store.list();

			expect(listing.ok).toBe(false);
			expect(listing.ok || listing.reason).toContain("EACCES");
		} finally {
			chmodSync(store.directory, 0o755);
		}
	});
});
