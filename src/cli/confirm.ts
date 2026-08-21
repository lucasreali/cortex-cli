import { warning } from "./style";

// Three answers, not two, because the two ways of not writing are not the same
// thing: a declined prompt is the user's decision and costs nothing, while a
// prompt that could never be shown is a command that did nothing for a reason
// only it can explain. Collapsing them to `false` is what made every caller
// re-check `isTTY` for itself.
export type Consent = "granted" | "declined" | "unavailable";

export function consent(question: string, assumeYes: boolean): Consent {
	if (assumeYes) return "granted";
	if (!process.stdin.isTTY) return "unavailable";
	return confirm(question) ? "granted" : "declined";
}

export function refusal(consented: Consent): number {
	if (consented === "declined") return 0;
	console.log(warning("non-interactive: nothing written — rerun with --yes"));
	return 1;
}
