import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionStore } from "@/decisions/decision-store";
import type { DecisionFile } from "@/domain";

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
		dependsOn: [],
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
		expect(store.listIds()).toEqual([]);
		expect(store.listUnparseableNames()).toEqual([]);
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

		expect(store.listIds()).toEqual([older, ID]);
		expect(store.listUnparseableNames()).toEqual([]);
	});

	test("reports a .md file whose name could never be looked up", () => {
		touch("notes.md");
		touch("019f6dc3-e77a-7000-8000.md");

		expect(store.listIds()).toEqual([ID]);
		expect(store.listUnparseableNames()).toEqual([
			"019f6dc3-e77a-7000-8000.md",
			"notes.md",
		]);
	});
});

describe("DecisionStore.write", () => {
	test("creates the directory, round-trips, and leaves no staging file", () => {
		const file = decisionFile();
		store.write(file);

		expect(store.read(ID)).toEqual({ ok: true, file });
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

		expect(store.listIds()).toEqual([ID]);
		expect(store.read(ID)).toEqual({
			ok: false,
			reason: "missing frontmatter fence",
		});
	});
});
