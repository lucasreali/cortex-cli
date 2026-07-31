import type { CodeIndex } from "@/indexer/lazy-code-index";
import type { CodeRepository } from "@/storage/code-repository";

// code.db is disposable: a missing grammar, a corrupt file or a failed
// reconcile is a state callers answer around, not one they die on.
export type CodeIndexAccess =
	| { ok: true; code: CodeRepository }
	| { ok: false; warning: string };

export async function accessCodeIndex(
	index: CodeIndex,
): Promise<CodeIndexAccess> {
	try {
		return { ok: true, code: await index.repository() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, warning: `code index unavailable: ${message}` };
	}
}
