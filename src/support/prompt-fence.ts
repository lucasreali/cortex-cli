const FENCE_TAG = "cortex_context";

export const PROMPT_FENCE_OPEN = `<${FENCE_TAG}`;
export const PROMPT_FENCE_CLOSE = `</${FENCE_TAG}>`;

// The fence is the only thing separating injected decision context from the
// user's own prompt, and a decision file reaches it through any merged pull
// request: a body carrying the closing tag would put everything after it
// outside the fence, as top-level instructions, on every prompt in that
// repository. Escaping both angle brackets is what makes a tag unspellable,
// and every caller escapes *before* truncating, so a cut cannot reassemble one
// out of the characters it leaves behind.
export function fenceSafe(text: string): string {
	return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// A diagnostic, never a rejection: after the escape nothing a decision carries
// can terminate the fence, so a file spelling the closing tag is no longer an
// exploit — it is an attempt, and the human reviewing that pull request is who
// should hear about it. Only the closing tag counts, because only the closing
// tag ever ended the fence; matching the opening one would fire on every
// decision that merely documents this.
export function breaksPromptFence(text: string): boolean {
	return text.includes(PROMPT_FENCE_CLOSE);
}
