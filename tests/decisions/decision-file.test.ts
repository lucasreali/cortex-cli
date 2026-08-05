import { describe, expect, test } from "bun:test";
import {
	formatDecisionFile,
	parseDecisionFile,
} from "@/decisions/decision-file";
import type { DecisionFile } from "@/domain";

const ID = "019f6dc3-e77a-7000-8000-000000000000";

function decisionFile(overrides: Partial<DecisionFile> = {}): DecisionFile {
	return {
		id: ID,
		title: "Adotar RRF entre BM25 e cosseno",
		body: "RRF k=60 sobre as duas pernas. Medido: 1.000 recall@5.",
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
		...overrides,
	};
}

function reparse(file: DecisionFile): DecisionFile | null {
	const parsed = parseDecisionFile(file.id, formatDecisionFile(file));
	return parsed.ok ? parsed.file : null;
}

function reasonFor(source: string): string | null {
	const parsed = parseDecisionFile(ID, source);
	return parsed.ok ? null : parsed.reason;
}

describe("formatDecisionFile", () => {
	test("writes every field in order when they are all set", () => {
		const file = decisionFile({
			module: "embedding",
			replaces: "019f0000-0000-7000-8000-000000000001",
			archives: "019f0000-0000-7000-8000-000000000004",
			dependsOn: ["019f0000-0000-7000-8000-000000000002"],
			conflictsWith: ["019f0000-0000-7000-8000-000000000003"],
			anchors: [
				{ filePath: "src/embedding/semantic-search.ts", symbol: "Search.run" },
				{ filePath: "src/storage/search-repository.ts", symbol: "" },
			],
			commitSha: "ca43a65",
			commitDirty: true,
		});

		expect(formatDecisionFile(file)).toBe(
			`---
title: "Adotar RRF entre BM25 e cosseno"
keywords: ["busca", "search", "rrf", "bm25", "embeddings"]
module: "embedding"
replaces: "019f0000-0000-7000-8000-000000000001"
archives: "019f0000-0000-7000-8000-000000000004"
depends_on: ["019f0000-0000-7000-8000-000000000002"]
conflicts_with: ["019f0000-0000-7000-8000-000000000003"]
anchors:
  - "src/embedding/semantic-search.ts#Search.run"
  - "src/storage/search-repository.ts"
commit: "ca43a65"
dirty: true
provenance: "agent"
created_at: "2026-07-22T14:03:11.204Z"
---

RRF k=60 sobre as duas pernas. Medido: 1.000 recall@5.
`,
		);
	});

	test("omits every empty field, and dirty without a commit to be dirty against", () => {
		expect(formatDecisionFile(decisionFile({ commitDirty: true }))).toBe(
			`---
title: "Adotar RRF entre BM25 e cosseno"
keywords: ["busca", "search", "rrf", "bm25", "embeddings"]
provenance: "agent"
created_at: "2026-07-22T14:03:11.204Z"
---

RRF k=60 sobre as duas pernas. Medido: 1.000 recall@5.
`,
		);
	});
});

describe("parseDecisionFile round-trips what the writer emits", () => {
	test("a body containing a horizontal rule survives the fence split", () => {
		const file = decisionFile({
			body: "Antes.\n\n---\n\nDepois, com # e -- dentro.",
		});

		expect(reparse(file)).toEqual(file);
	});

	test("scalars that YAML would retype come back as strings", () => {
		for (const title of ["no", "true", "1.0", "2026-07-22", "~", "null"]) {
			const file = decisionFile({ title, keywords: [title] });
			expect(reparse(file)).toEqual(file);
		}
	});

	test("quotes, backslashes, newlines and non-BMP characters survive", () => {
		const file = decisionFile({
			title: 'Aspas " barra \\ tab\t e emoji 🧠',
			body: "Linha um\nLinha dois: com # comentário falso",
			keywords: ["a: b", "- c", "#d"],
			module: "@scope/pkg",
		});

		expect(reparse(file)).toEqual(file);
	});

	test("CRLF input parses identically to LF", () => {
		const file = decisionFile({ module: "embedding" });
		const crlf = formatDecisionFile(file).replaceAll("\n", "\r\n");

		expect(parseDecisionFile(ID, crlf)).toEqual({ ok: true, file });
	});
});

describe("parseDecisionFile anchors", () => {
	test("splits on the last hash, treating a bare path as file-level", () => {
		const anchors = [
			{ filePath: "src/a.ts", symbol: "Class.method" },
			{ filePath: "src/b.ts", symbol: "" },
			{ filePath: "src/we#ird.ts", symbol: "Sym" },
		];

		expect(reparse(decisionFile({ anchors }))?.anchors).toEqual(anchors);
	});

	test("a trailing hash is the file-level anchor, not an empty symbol", () => {
		const parsed = parseDecisionFile(
			ID,
			`---
title: "Uma decisão qualquer"
keywords: ["a"]
anchors: ["src/a.ts#"]
provenance: "agent"
created_at: "2026-07-22T14:03:11.204Z"
---

Corpo.
`,
		);

		expect(parsed.ok && parsed.file.anchors).toEqual([
			{ filePath: "src/a.ts", symbol: "" },
		]);
	});
});

describe("parseDecisionFile rejects malformed files", () => {
	const valid = `title: "Uma decisão qualquer"
keywords: ["a"]
provenance: "agent"
created_at: "2026-07-22T14:03:11.204Z"`;

	function withFrontmatter(frontmatter: string, body = "Corpo."): string {
		return `---\n${frontmatter}\n---\n\n${body}\n`;
	}

	test("names what is wrong with the fence", () => {
		expect(reasonFor("title: nada\n")).toBe("missing frontmatter fence");
		expect(reasonFor("---\ntitle: nada\n")).toBe(
			"unterminated frontmatter fence",
		);
	});

	test("names what is wrong inside the frontmatter", () => {
		expect(reasonFor(withFrontmatter(""))).toBe("empty frontmatter");
		expect(reasonFor(withFrontmatter('title: "x\nkeywords: ['))).toContain(
			"invalid YAML",
		);
		expect(reasonFor(withFrontmatter('keywords: ["a"]'))).toBe(
			"title must be a non-empty string",
		);
		expect(reasonFor(withFrontmatter(valid, ""))).toBe("body is empty");
		expect(reasonFor(withFrontmatter('title: "x"'))).toBe(
			"keywords must be a list of strings",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nkeywords: ["a", 7]`))).toBe(
			"keywords must be a list of strings",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nmodule: 7`))).toBe(
			"module must be a string",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nreplaces: 7`))).toBe(
			"replaces must be a string",
		);
		expect(reasonFor(withFrontmatter(`${valid}\narchives: 7`))).toBe(
			"archives must be a string",
		);
		expect(reasonFor(withFrontmatter(`${valid}\ndepends_on: "x"`))).toBe(
			"depends_on must be a list of strings",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nconflicts_with: "x"`))).toBe(
			"conflicts_with must be a list of strings",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nanchors: "x"`))).toBe(
			"anchors must be a list of strings",
		);
		expect(reasonFor(withFrontmatter(`${valid}\ncommit: 7`))).toBe(
			"commit must be a string",
		);
		expect(reasonFor(withFrontmatter(`${valid}\ndirty: "yes"`))).toBe(
			"dirty must be a boolean",
		);
		expect(reasonFor(withFrontmatter(`${valid}\nprovenance: "robot"`))).toBe(
			"provenance must be one of agent, human",
		);
		expect(reasonFor(withFrontmatter(`${valid}\ncreated_at: 7`))).toBe(
			"created_at must be a non-empty string",
		);
	});

	test("a top-level list is not frontmatter", () => {
		expect(reasonFor(withFrontmatter("- a\n- b"))).toBe("empty frontmatter");
	});
});

describe("parseDecisionFile tolerates what the save tool would refuse", () => {
	test("a decision below the authoring minimums still loads", () => {
		const file = decisionFile({ title: "curto", body: "breve", keywords: [] });

		expect(reparse(file)).toEqual(file);
	});

	test("an unknown key is ignored rather than rejected", () => {
		const parsed = parseDecisionFile(
			ID,
			`---
title: "Uma decisão qualquer"
keywords: ["a"]
confidence: 0.9
provenance: "agent"
created_at: "2026-07-22T14:03:11.204Z"
---

Corpo.
`,
		);

		expect(parsed.ok && parsed.file.title).toBe("Uma decisão qualquer");
	});
});
