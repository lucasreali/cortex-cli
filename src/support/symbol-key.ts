// The one recipe for turning a symbol name into something two producers can
// compare. Three of them exist — the tree-sitter extractor, the anchor symbols
// an LLM writes through save_decision, and the matching side that reconciles
// the two — and any disagreement between them splits one symbol into a stored
// row nothing ever finds again.
//
// Step order is the whole point, and it is not interchangeable: every step that
// can *expand* a character runs before the step that drops characters.
// Decomposition expands (U+FB01 'ﬁ' becomes 'f' 'i'; 'é' becomes 'e' plus a
// combining acute), and so does case mapping — in JS, "İ".toLowerCase() is "i"
// followed by U+0307 COMBINING DOT ABOVE, one code point becoming two. Drop the
// non-identifier characters first and that combining mark survives into the
// output, where a second pass would then remove it: f(f(x)) !== f(x), and the
// extractor and the matcher disagree on every Turkish identifier. Sweeping
// every code point up to U+2FFFF, U+0130 is the sole character that breaks
// idempotence under the wrong order — one character is enough, and it is a
// legal TypeScript identifier.

export const QUALIFIED_SEPARATOR = ".";

const OUTSIDE_IDENTIFIER = /[^\p{L}\p{N}_$.]/gu;

export interface SymbolKeyParts {
	key: string;
	owner: string;
	lastSegment: string;
}

// What the code index stores: canonical Unicode form, no combining marks, no
// characters an identifier cannot contain — but the case a human wrote, because
// this name is shown back as a suggestion and an LLM copies it into a decision
// file, which is immutable once written.
export function canonicalSymbolName(raw: string): string {
	return tighten(raw.normalize("NFKD"));
}

// What every comparison uses. `symbolKey(canonicalSymbolName(x))` equals
// `symbolKey(x)`, so normalizing on the way into the index never changes the
// answer the matching side computes.
export function symbolKey(name: string): string {
	return tighten(name.normalize("NFKD").toLowerCase());
}

export function symbolKeyParts(name: string): SymbolKeyParts {
	const key = symbolKey(name);
	const segments = key.split(QUALIFIED_SEPARATOR);
	const lastSegment = segments[segments.length - 1] ?? key;
	return {
		key,
		owner: segments.slice(0, -1).join(QUALIFIED_SEPARATOR),
		lastSegment,
	};
}

function tighten(expanded: string): string {
	return expanded
		.replace(OUTSIDE_IDENTIFIER, "")
		.split(QUALIFIED_SEPARATOR)
		.filter((segment) => segment.length > 0)
		.join(QUALIFIED_SEPARATOR);
}
