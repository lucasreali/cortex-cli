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

export const anchorInputSchema = z.strictObject({
	file_path: z
		.string()
		.min(1)
		.refine(isRepoRelative, REPO_RELATIVE)
		.describe("Repo-relative path of a file this decision governs."),
	symbol: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Qualified symbol inside that file, exactly as indexed — e.g. " +
				"'AuthService.validateToken'. Omit for a file-level anchor.",
		),
});

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
			"What was decided and why: the choice, the rationale, what was " +
				"rejected and the trade-offs accepted.",
		),
	keywords: z
		.array(z.string().min(1))
		.min(MINIMUM_KEYWORDS)
		.describe(
			"Search terms for this decision. Mix Portuguese and English variants " +
				"of the concepts involved (e.g. 'autenticação', 'authentication', " +
				"'jwt', 'login', 'sessão') so both languages find it.",
		),
	module: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Module/area label (e.g. 'auth'). Reuse values from get_context's " +
				"modules list when one fits.",
		),
	anchors: z
		.array(anchorInputSchema)
		.optional()
		.describe("Files/symbols this decision governs."),
	depends_on: z
		.array(z.uuid())
		.optional()
		.describe("Ids of decisions this one builds on; impact walks these links."),
	replaces: z
		.uuid()
		.optional()
		.describe(
			"Id of the decision this one supersedes (archived, not deleted).",
		),
	archives: z
		.uuid()
		.optional()
		.describe(
			"Id of a decision that no longer applies and has no successor — " +
				"retired, never deleted. Use replaces when this decision supersedes " +
				"it instead.",
		),
	conflicts_with: z
		.array(z.uuid())
		.optional()
		.describe(
			"Ids of decisions this one contradicts. Declare only confirmed " +
				"contradictions — near-duplicates suggested in conflict_candidates " +
				"belong here only after you verified they genuinely disagree.",
		),
});

export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
