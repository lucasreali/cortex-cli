import { z } from "zod";

export const anchorInputSchema = z.strictObject({
	file_path: z.string().min(1),
	symbol: z.string().min(1).optional(),
});

export const createDecisionSchema = z.strictObject({
	title: z.string().min(8),
	body: z.string().min(30),
	keywords: z
		.array(z.string().min(1))
		.min(5)
		.describe(
			"Search terms for this decision. Mix Portuguese and English variants " +
				"of the concepts involved (e.g. 'autenticação', 'authentication', " +
				"'jwt', 'login', 'sessão') so both languages find it.",
		),
	module: z.string().min(1).optional(),
	anchors: z.array(anchorInputSchema).optional(),
	depends_on: z.array(z.uuid()).optional(),
	replaces: z.uuid().optional(),
});

export type AnchorInput = z.infer<typeof anchorInputSchema>;
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;
