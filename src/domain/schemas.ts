import { z } from "zod";

export const MINIMUM_KEYWORDS = 5;

// An anchor is written into a file that is immutable once committed, so a path
// that escapes the repository is not a mistake anyone can edit away: it stays
// there, and every resolver that reads it — anchor grading, doctor's orphan
// check, the code index — probes for a file outside the project on every run.
// Repo-relative is what the format has always meant; this is where it is said.
const REPO_RELATIVE =
	"file_path must be repo-relative: no leading '/' or '~', no drive letter, " +
	"no '..' segment";

function isRepoRelative(path: string): boolean {
	if (path.startsWith("/") || path.startsWith("~")) return false;
	if (/^[A-Za-z]:[\\/]/.test(path)) return false;
	return !path.split(/[\\/]/).includes("..");
}

// `#` separates the path from the symbol in the file format, and the code
// index strips it from an ECMAScript private name (`Foo.#bar` is indexed as
// `Foo.bar`), so a symbol spelled with one would only ever come back split in
// the wrong place on every other clone.
const NO_HASH_IN_SYMBOL =
	"symbol must not contain '#': private members are indexed without it " +
	"(write 'Foo.bar' for 'Foo.#bar')";

export const anchorInputSchema = z.strictObject({
	file_path: z
		.string()
		.min(1)
		.refine(isRepoRelative, REPO_RELATIVE)
		.describe("Repo-relative path of a file this decision governs."),
	symbol: z
		.string()
		.min(1)
		.refine((symbol) => !symbol.includes("#"), NO_HASH_IN_SYMBOL)
		.optional()
		.describe("Qualified symbol as indexed; omit for the whole file."),
});

// z.uuid() publishes a 170-character pattern in every tool listing, repeated
// once per link field; the format keyword says the same to a client, and the
// id is checked against the store before anything is saved anyway.
const UUID = z.uuid();
const decisionId = () =>
	z
		.string()
		.refine((value) => UUID.safeParse(value).success, "must be a decision id")
		.meta({ format: "uuid" });

export const createDecisionSchema = z.strictObject({
	title: z
		.string()
		.min(8)
		.describe("Self-contained one-line summary, readable months from now."),
	// Trimmed before it is measured, and stored trimmed: the file format trims
	// the body back out on the way in, so a body that is only whitespace would
	// otherwise save, return an id, and parse as malformed forever — and vanish
	// entirely from a fresh clone, where the store rebuilds from the files.
	body: z
		.string()
		.trim()
		.min(30)
		.describe(
			"The choice, why, and the alternatives rejected — about 120 words.",
		),
	keywords: z
		.array(z.string().min(1))
		.min(MINIMUM_KEYWORDS)
		.describe(
			"Search terms mixing Portuguese and English variants (e.g. " +
				"'autenticação', 'authentication', 'jwt') so both languages find it.",
		),
	module: z
		.string()
		.min(1)
		.optional()
		.describe("Module label (e.g. 'auth'); reuse get_context's modules."),
	anchors: z
		.array(anchorInputSchema)
		.optional()
		.describe("Files/symbols this decision governs."),
	depends_on: z
		.array(decisionId())
		.optional()
		.describe("Ids of decisions this one builds on; impact walks these links."),
	replaces: decisionId()
		.optional()
		.describe("Id of the decision this one supersedes."),
	archives: decisionId()
		.optional()
		.describe("Id of a decision that no longer applies, with no successor."),
	conflicts_with: z
		.array(decisionId())
		.optional()
		.describe("Ids of decisions this one is confirmed to contradict."),
});

export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
