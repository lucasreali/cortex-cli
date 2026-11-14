import type { Decision } from "@/domain";

export interface DuplicatePair {
	kept: Decision;
	duplicate: Decision;
}

export interface DecisionContentFlag {
	decision: Decision;
	reason: string;
}

// Words that name no topic at all, only the shape of a request. As a keyword
// one of them makes the prompt hook inject that decision on nearly every
// prompt — exactly what a pull request wanting its text in front of the model
// would choose. Topical words, however common ("cli", "config", "erro"), stay
// out: a store that curates them as keywords means them. Function words are
// not here either: the hook never matches those at all.
const CATCH_ALL_KEYWORDS = new Set(
	`ajuda bug bugs feature features help improvement issue issues melhoria
	problem problema problems todo`
		.split(/\s+/)
		.filter((word) => word.length > 0),
);

const LINK = /\bhttps?:\/\/[^\s)>\]]+/i;
const COMMAND =
	/\b(?:curl|wget)\s+\S|\brm\s+-[a-z]*r[a-z]*f|\bsudo\s|\|\s*(?:ba|z)?sh\b|\bbash\s+-c\b|\bpowershell\b|\binvoke-expression\b|\biex\s*\(/i;
const OVERRIDE =
	/\b(?:ignore|disregard)\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions\b|\bignore\s+as\s+instru[cç][oõ]es\b/i;

// Two active decisions with the same title or the same body are one decision
// recorded twice — usually by two sessions that never saw each other — and
// search then answers with both. The older one is kept; `replaces` on a new
// file is how the other is retired.
export function duplicateDecisions(decisions: Decision[]): DuplicatePair[] {
	const byKey = new Map<string, Decision>();
	const pairs: DuplicatePair[] = [];
	const ordered = [...decisions].sort((one, other) =>
		one.id.localeCompare(other.id),
	);
	for (const decision of ordered) {
		const keys = [
			`title:${folded(decision.title)}`,
			`body:${folded(decision.body)}`,
		];
		const kept = keys.map((key) => byKey.get(key)).find(Boolean);
		if (kept) {
			pairs.push({ kept, duplicate: decision });
			continue;
		}
		for (const key of keys) byKey.set(key, decision);
	}
	return pairs;
}

// What the prompt hook would put in front of a model and a reviewer should
// read first: links, shell commands and instructions aimed at an assistant are
// not what a decision records, and a catch-all keyword is how such a file gets
// injected everywhere. Reported, never refused — the hook already frames the
// text as data, and dropping a decision over a string is the larger damage.
export function flaggedContent(decisions: Decision[]): DecisionContentFlag[] {
	return decisions.flatMap((decision) => {
		const text = `${decision.title}\n${decision.body}`;
		const reasons = [
			...(LINK.test(text) ? ["links to a URL"] : []),
			...(COMMAND.test(text) ? ["contains a shell command"] : []),
			...(OVERRIDE.test(text) ? ["addresses instructions to the model"] : []),
			...catchAllKeywords(decision).map(
				(keyword) =>
					`keyword "${keyword}" matches most prompts, so the hook injects it almost always`,
			),
		];
		return reasons.map((reason) => ({ decision, reason }));
	});
}

function catchAllKeywords(decision: Decision): string[] {
	return decision.keywords.filter((keyword) =>
		CATCH_ALL_KEYWORDS.has(folded(keyword)),
	);
}

function folded(text: string): string {
	return text
		.normalize("NFD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}
