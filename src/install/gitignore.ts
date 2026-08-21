export type GitignorePlan =
	| { action: "satisfied" }
	| { action: "append"; content: string }
	| { action: "conflict"; missing: string[] };

// The rules are order-dependent and git resolves them last-match-wins: the
// exclusion has to come first and every negation after it. So appending only
// what is missing is safe in one direction and destructive in the other — a
// file that already negates `config` and does not exclude the directory would
// have the exclusion appended *below* the negation, and the decisions this was
// meant to version would stop being tracked. Re-appending the whole set is the
// same damage plus a duplicate. When the half that is present is the half that
// makes appending safe, append; otherwise say which rules are missing and let
// the person who wrote that file decide where they go.
export function planGitignore(
	current: string,
	rules: readonly string[],
): GitignorePlan {
	const [exclusion, ...negations] = rules;
	if (exclusion === undefined) return { action: "satisfied" };
	const present = new Set(current.split("\n").map((line) => line.trim()));
	const missing = rules.filter((rule) => !present.has(rule));
	if (missing.length === 0) return { action: "satisfied" };
	if (!present.has(exclusion) && negations.some((rule) => present.has(rule))) {
		return { action: "conflict", missing };
	}
	const separator = current === "" || current.endsWith("\n") ? "" : "\n";
	const appended = present.has(exclusion) ? missing : rules;
	return {
		action: "append",
		content: `${current}${separator}${appended.join("\n")}\n`,
	};
}
