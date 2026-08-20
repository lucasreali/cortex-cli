import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	anchorsByDecision,
	indexedAnchorResolver,
	labelAnchors,
	strongestConfidence,
	unjudgedAnchorResolver,
} from "@/app/anchor-confidence";
import type { AnchorConfidence, Decision } from "@/domain";
import type { CodeIndex } from "@/indexer/lazy-code-index";
import { CodeRepository } from "@/storage/code-repository";
import { openCodeDb } from "@/storage/connection";
import { migrateCode } from "@/storage/migrations";

const INDEXED_FILE = "src/auth/service.ts";
const OTHER_INDEXED_FILE = "src/auth/tokens.ts";
const SHELL_FILE = "install.sh";

let dir: string;
let codeDb: Database;
let code: CodeRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cortex-anchor-confidence-"));
	codeDb = openCodeDb(dir);
	migrateCode(codeDb);
	code = new CodeRepository(codeDb);
	code.wipeAndRebuild([
		{
			file: {
				path: INDEXED_FILE,
				lang: "ts",
				hash: "a",
				mtime: 1,
				size: 1,
			},
			symbols: [{ name: "AuthService.login", kind: "method", line: 10 }],
			imports: [],
		},
		{
			file: {
				path: OTHER_INDEXED_FILE,
				lang: "ts",
				hash: "b",
				mtime: 1,
				size: 1,
			},
			symbols: [{ name: "rotateRefreshToken", kind: "function", line: 4 }],
			imports: [],
		},
	]);
	writeFile(INDEXED_FILE);
	writeFile(OTHER_INDEXED_FILE);
	writeFile(SHELL_FILE);
});

afterEach(() => {
	codeDb.close();
	rmSync(dir, { recursive: true, force: true });
});

function writeFile(path: string): void {
	const absolute = join(dir, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, "content\n");
}

function decision(anchors: Array<[string, string]>): Decision {
	return {
		id: "019f0000-0000-7000-8000-000000000000",
		title: "Decisão ancorada no serviço de autenticação",
		body: "Corpo suficientemente longo para a decisão fazer sentido sozinha.",
		keywords: ["um", "dois", "três", "four", "five"],
		module: null,
		status: "active",
		present: true,
		commitSha: null,
		commitDirty: false,
		provenance: "agent",
		props: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		anchors: anchors.map(([filePath, symbol]) => ({ filePath, symbol })),
	};
}

function confidences(anchors: Array<[string, string]>): AnchorConfidence[] {
	return indexedAnchorResolver(dir, code)
		.label(decision(anchors))
		.anchors.map((anchor) => anchor.confidence);
}

function workingCodeIndex(): CodeIndex {
	return { repository: async () => code, dispose() {} };
}

function brokenCodeIndex(): CodeIndex {
	return {
		repository: () => Promise.reject(new Error("grammar download failed")),
		dispose() {},
	};
}

describe("anchor confidence", () => {
	test("a symbol the anchored file declares resolves exactly", () => {
		expect(confidences([[INDEXED_FILE, "AuthService.login"]])).toEqual([
			"exact",
		]);
	});

	test("a symbol indexed under another file resolves by name only", () => {
		expect(confidences([[INDEXED_FILE, "rotateRefreshToken"]])).toEqual([
			"name_only",
		]);
	});

	test("an anchor without a symbol stays at file level", () => {
		expect(confidences([[INDEXED_FILE, ""]])).toEqual(["file_only"]);
	});

	test("a file the indexer does not cover keeps its symbol claim unjudged", () => {
		expect(confidences([[SHELL_FILE, "detect_suffix"]])).toEqual(["file_only"]);
	});

	test("a symbol missing from a file the index holds is unresolved", () => {
		expect(confidences([[INDEXED_FILE, "AuthService.logout"]])).toEqual([
			"unresolved",
		]);
	});

	test("an anchor whose file left the working tree is unresolved", () => {
		expect(
			confidences([
				["src/auth/gone.ts", ""],
				["src/auth/gone.ts", "vanished"],
			]),
		).toEqual(["unresolved", "unresolved"]);
	});

	test("an unreadable code index judges nothing", () => {
		const labelled = unjudgedAnchorResolver().label(
			decision([[INDEXED_FILE, "AuthService.login"]]),
		);
		expect(labelled.anchors).toEqual([
			{
				filePath: INDEXED_FILE,
				symbol: "AuthService.login",
				confidence: "unknown",
			},
		]);
	});
});

describe("labelAnchors", () => {
	test("labels every decision against the code index", async () => {
		const labelled = await labelAnchors(
			{ repoRoot: dir, codeIndex: workingCodeIndex() },
			[
				decision([[INDEXED_FILE, "AuthService.login"]]),
				decision([[SHELL_FILE, ""]]),
			],
		);
		expect(labelled.map((entry) => entry.anchors[0]?.confidence)).toEqual([
			"exact",
			"file_only",
		]);
	});

	test("decisions without anchors never reach for the code index", async () => {
		const labelled = await labelAnchors(
			{ repoRoot: dir, codeIndex: brokenCodeIndex() },
			[decision([])],
		);
		expect(labelled[0]?.anchors).toEqual([]);
	});

	test("an unavailable code index degrades to unknown, not to an error", async () => {
		const labelled = await labelAnchors(
			{ repoRoot: dir, codeIndex: brokenCodeIndex() },
			[decision([[INDEXED_FILE, "AuthService.login"]])],
		);
		expect(labelled[0]?.anchors[0]?.confidence).toBe("unknown");
	});

	// The whole table has to be read to answer "where else does this name live?",
	// so reading it once per anchor is what turns ten decisions into seconds of
	// CPU inside one MCP call.
	test("the symbol table is read once per request, not once per anchor", async () => {
		const scan = spyOn(code, "symbolTable");
		await labelAnchors({ repoRoot: dir, codeIndex: workingCodeIndex() }, [
			decision([
				[INDEXED_FILE, "rotateRefreshToken"],
				[INDEXED_FILE, "AuthService.logout"],
			]),
			decision([[OTHER_INDEXED_FILE, "AuthService.login"]]),
		]);
		expect(scan).toHaveBeenCalledTimes(1);
		scan.mockRestore();
	});

	test("anchors that all resolve exactly never read the symbol table", async () => {
		const scan = spyOn(code, "symbolTable");
		await labelAnchors({ repoRoot: dir, codeIndex: workingCodeIndex() }, [
			decision([[INDEXED_FILE, "AuthService.login"]]),
		]);
		expect(scan).not.toHaveBeenCalled();
		scan.mockRestore();
	});

	test("anchorsByDecision keys the resolved anchors by decision id", async () => {
		const anchors = await anchorsByDecision(
			{ repoRoot: dir, codeIndex: workingCodeIndex() },
			[decision([[INDEXED_FILE, "AuthService.login"]])],
		);
		expect(anchors.get("019f0000-0000-7000-8000-000000000000")).toEqual([
			{
				filePath: INDEXED_FILE,
				symbol: "AuthService.login",
				confidence: "exact",
			},
		]);
	});
});

describe("strongestConfidence", () => {
	test("keeps the strongest label among the anchors that matched", () => {
		const labelled = indexedAnchorResolver(dir, code).label(
			decision([
				["src/auth/gone.ts", ""],
				[INDEXED_FILE, "AuthService.login"],
				[SHELL_FILE, ""],
			]),
		);
		expect(strongestConfidence(labelled.anchors)).toBe("exact");
	});

	test("answers null when nothing matched", () => {
		expect(strongestConfidence([])).toBeNull();
	});
});
