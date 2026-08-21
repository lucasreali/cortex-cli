const ESCAPE_CHARACTER = "\\";

// LIKE's own wildcards have to survive as literals: a symbol key keeps `_` and
// a file path may hold `%`, and either one silently widens the match. The
// queries that interpolate the result must declare ESCAPE '\'.
export function likeLiteral(value: string): string {
	return value.replaceAll(
		/[\\%_]/g,
		(character) => `${ESCAPE_CHARACTER}${character}`,
	);
}
