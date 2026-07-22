import { z } from "zod";

export const anchorInputSchema = z.strictObject({
	file_path: z
		.string()
		.min(1)
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
	body: z
		.string()
		.min(30)
		.describe(
			"What was decided and why: the choice, the rationale, what was " +
				"rejected and the trade-offs accepted.",
		),
	keywords: z
		.array(z.string().min(1))
		.min(5)
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
});

export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
