import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	CORTEX_INSTRUCTIONS_BODY,
	INSTRUCTIONS_BLOCK,
} from "@/install/instructions";
import type { BlockUpsert } from "@/install/marked-block";

const ROOT = new URL("../../", import.meta.url).pathname;

const FILE_EXTENSION = /\.(ts|sql|md|toml|json|sh|db|info)$/;
const NOT_A_REPO_PATH = /^(?:~|@\/|\.\.?\/)|^\.[a-z]+$/;

const PASCAL_CASE = /^[A-Z][a-z0-9]+(?:[A-Z][a-zA-Z0-9]*)*$/;
const SCREAMING_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const CAMEL_CASE = /^[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+$/;
const LOWER_SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const IDENTIFIER_SHAPES = [
	PASCAL_CASE,
	SCREAMING_SNAKE_CASE,
	CAMEL_CASE,
	LOWER_SNAKE_CASE,
];

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
const COMMAND_DIRECTORY = "src/cli/commands";

const LINE_AND_BLOCK_COMMENTS: Record<string, RegExp> = {
	ts: /\/\*[\s\S]*?\*\/|\/\/.*/g,
	sql: /--.*/g,
	sh: /#.*/g,
};

const NOT_IN_THE_TREE: Record<string, string> = {
	"decisions.db": "derived store, gitignored, created at runtime",
	"code.db": "derived store, gitignored, created at runtime",
	"lcov.info": "coverage output, written by bun test --coverage",
	content_sha: "a column CLAUDE.md says it deliberately does not have yet",
	FinalizationRegistry:
		"the hook web-tree-sitter does not register — the absence is the point",
	symbol_key:
		"the anchors column CLAUDE.md rejects — a second copy of the symbol recipe",
};

const MINIMUM_REFERENCES = 25;

function codeSpans(markdown: string): string[] {
	const spans = [...markdown.matchAll(/`([^`\n]+)`/g)].map(
		(match) => match[1] ?? "",
	);
	return [...new Set(spans)];
}

function isPathReference(span: string): boolean {
	if (/[\s<>]/.test(span)) return false;
	if (NOT_A_REPO_PATH.test(span)) return false;
	return span.includes("/") || FILE_EXTENSION.test(span);
}

function isIdentifierReference(span: string): boolean {
	return IDENTIFIER_SHAPES.some((shape) => shape.test(span));
}

function isCommandReference(span: string): boolean {
	return KEBAB_CASE.test(span);
}

function isExempt(span: string): boolean {
	return Object.hasOwn(NOT_IN_THE_TREE, span);
}

async function scan(patterns: string[]): Promise<string[]> {
	const scans = patterns.map((pattern) =>
		Array.fromAsync(new Bun.Glob(pattern).scan(ROOT)),
	);
	return (await Promise.all(scans)).flat();
}

function stripComments(source: string, file: string): string {
	const syntax = LINE_AND_BLOCK_COMMENTS[file.split(".").pop() ?? ""];
	if (!syntax) return source;
	return source.replace(syntax, " ");
}

async function readStripped(file: string): Promise<string> {
	return stripComments(await Bun.file(join(ROOT, file)).text(), file);
}

// Committed source only, comments stripped, `tests/` excluded: a name that
// survives in a derived store, in a stale comment or in a fixture has not
// survived in the code, and a corpus reaching into gitignored state would pass
// here and fail on a fresh clone.
const sources = await scan([
	"src/**/*.ts",
	"src/**/*.sql",
	"scripts/*.ts",
	"install.sh",
]);
const corpus = (await Promise.all(sources.map(readStripped))).join("\n");
const sourceTree = await scan(["src/**/*.ts"]);

const markdown = await Bun.file(join(ROOT, "CLAUDE.md")).text();
const spans = codeSpans(markdown);

// A command line cites its own paths: `bun src/cli/main.ts <command>` is the
// only mention of the dispatch table's full path, and a bare `main.ts` would
// resolve against the daemon's.
const paths = spans
	.flatMap((span) => span.split(/\s+/))
	.filter(isPathReference)
	.filter((span) => !isExempt(span));
const identifiers = spans
	.filter(isIdentifierReference)
	.filter((span) => !isExempt(span));
const commands = spans
	.filter(isCommandReference)
	.filter((span) => !isExempt(span));

function resolveInTree(span: string): string | null {
	const bare = span.replace(/\/$/, "");
	const candidates = [
		bare,
		join("src", bare),
		`${bare}.ts`,
		join("src", `${bare}.ts`),
	];
	const direct = candidates.find((path) => existsSync(join(ROOT, path)));
	if (direct) return direct;
	if (span.includes("/")) return null;
	return sourceTree.find((path) => path.endsWith(`/${span}`)) ?? null;
}

function resolveCommand(span: string): string | null {
	const file = join(COMMAND_DIRECTORY, `${span}.ts`);
	if (existsSync(join(ROOT, file))) return file;
	return null;
}

// The names CLAUDE.md cites are TypeScript exports, SQL tables, MCP tool names
// that exist only as string literals and one shell function, so whole-word
// presence is the one check that covers all four without parsing four
// languages — and it still fails the rename it exists to catch.
function appearsInSource(name: string): boolean {
	return new RegExp(`\\b${name}\\b`).test(corpus);
}

function existsInRepo(span: string): boolean {
	if (isPathReference(span)) return resolveInTree(span) !== null;
	if (isCommandReference(span)) return resolveCommand(span) !== null;
	return appearsInSource(span);
}

describe("CLAUDE.md names things that exist", () => {
	test("every path it cites resolves in the tree", () => {
		for (const span of paths) {
			expect(resolveInTree(span), `CLAUDE.md cites ${span}`).not.toBeNull();
		}
	});

	test("every identifier it cites appears in the source", () => {
		for (const span of identifiers) {
			expect(appearsInSource(span), `CLAUDE.md cites ${span}`).toBe(true);
		}
	});

	test("every hidden command it cites has a command file", () => {
		for (const span of commands) {
			expect(resolveCommand(span), `CLAUDE.md cites ${span}`).not.toBeNull();
		}
	});

	test("the extractor still matches paths and identifiers", () => {
		expect(paths.length).toBeGreaterThanOrEqual(MINIMUM_REFERENCES);
		expect(identifiers.length).toBeGreaterThanOrEqual(MINIMUM_REFERENCES);
		expect(commands.length).toBeGreaterThan(0);
	});

	test("no stale exemptions", () => {
		for (const [span, reason] of Object.entries(NOT_IN_THE_TREE)) {
			expect(
				spans,
				`${span} is exempt (${reason}) but is no longer cited`,
			).toContain(span);
			expect(
				existsInRepo(span),
				`${span} resolves now — drop it from the exemption map`,
			).toBe(false);
		}
	});
});

const REGENERATION =
	"the region between the cortex markers is generated from " +
	"CORTEX_INSTRUCTIONS_BODY (src/install/instructions.ts): regenerate it by " +
	"running `cortex init` in this repo, or paste that constant between the " +
	"markers verbatim";

const BLOCK_DIAGNOSIS: Record<BlockUpsert["action"], string> = {
	unchanged: "the fenced block matches",
	updated: "the fenced block has drifted from CORTEX_INSTRUCTIONS_BODY",
	created: "CLAUDE.md is empty",
	appended: "CLAUDE.md has no <!-- cortex:begin --> marker",
	"skipped-malformed":
		"<!-- cortex:begin --> has no matching <!-- cortex:end -->",
};

const MARKERS_FOUND: BlockUpsert["action"][] = ["unchanged", "updated"];

// Asking `upsert` what it would write keeps one marker recipe instead of a
// second parser here, and makes every way of losing the block a distinct
// action: only `unchanged` means CLAUDE.md already holds the generated body,
// so a fence that went missing fails rather than passing vacuously.
const blockState = INSTRUCTIONS_BLOCK.upsert(
	markdown,
	CORTEX_INSTRUCTIONS_BODY,
);

function diagnose(state: BlockUpsert): string {
	return `${BLOCK_DIAGNOSIS[state.action]} — ${REGENERATION}`;
}

describe("CLAUDE.md dogfoods the instruction block cortex installs", () => {
	test("both cortex markers are present and paired", () => {
		expect(MARKERS_FOUND, diagnose(blockState)).toContain(blockState.action);
	});

	test("the fenced block is CORTEX_INSTRUCTIONS_BODY verbatim", () => {
		expect(blockState.action, diagnose(blockState)).toBe("unchanged");
	});
});
