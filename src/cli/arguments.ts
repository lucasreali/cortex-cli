// Flags stop at `--`: everything after it is a positional, including a word
// that looks like a flag. Without this, `cortex search -- -h` prints help
// instead of searching for the term `-h`, and no quoting can say otherwise.
export function flagsIn(args: readonly string[]): readonly string[] {
	const terminator = args.indexOf("--");
	return terminator === -1 ? args : args.slice(0, terminator);
}

// A blank argument is a missing one, in every command: a shell glob that
// matched nothing expands to an empty word, and no command here has an answer
// for the empty path, the empty id or the empty term.
export function presentArguments(positionals: readonly string[]): string[] {
	return positionals.filter((value) => value.trim() !== "");
}

// `Number` accepts `1e3`, `0x10`, `.5` and leading whitespace, none of which a
// person typed on purpose after `--depth`. A count is spelled in digits.
export function wholeNumber(raw: string): number | null {
	return /^\d+$/.test(raw) ? Number(raw) : null;
}
