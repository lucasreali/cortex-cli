import type { CodeRepository } from "@/storage/code-repository";

const SUGGESTION_LIMIT = 3;

export function symbolHint(
	code: CodeRepository,
	filePath: string,
	symbol: string,
): string {
	const suggestions = code.suggestSymbols(filePath, symbol, SUGGESTION_LIMIT);
	if (suggestions.length === 0) return "";
	return ` — did you mean: ${suggestions.join(", ")}?`;
}
