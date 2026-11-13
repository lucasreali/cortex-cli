import type { Anchor } from "./types";

const SEPARATOR = "#";

// The one textual form of an anchor, shared by the file format and the export
// query's reader. A symbol never contains `#` (the save schema refuses it), so
// the separator is unambiguous for everything written from now on.
export function formatAnchorText(anchor: Anchor): string {
	if (anchor.symbol === "") return anchor.filePath;
	return `${anchor.filePath}${SEPARATOR}${anchor.symbol}`;
}

// A path may legitimately contain a `#`, so the last one usually wins — except
// that files written before the schema refused it can carry an ECMAScript
// private member, `src/x.ts#Foo.#secret`, whose last `#` follows a `.`. That
// `#` is part of the symbol, never the separator: a path segment ending in a
// dot right before a `#` is not a spelling anyone writes.
export function parseAnchorText(entry: string): Anchor {
	const hash = separatorIndex(entry);
	if (hash === -1) return { filePath: normalizeAnchorPath(entry), symbol: "" };
	return {
		filePath: normalizeAnchorPath(entry.slice(0, hash)),
		symbol: entry.slice(hash + 1),
	};
}

function separatorIndex(entry: string): number {
	let hash = entry.lastIndexOf(SEPARATOR);
	while (hash > 0 && entry[hash - 1] === ".") {
		hash = entry.lastIndexOf(SEPARATOR, hash - 1);
	}
	return hash;
}

// Every comparison against an anchor is exact — the code index, `why --file`,
// `get_impact` — and the index spells paths with forward slashes and no `./`.
// An anchor written on Windows (`src\auth.ts`) or by hand (`./src/auth.ts`)
// used to be a file nothing ever matched. Normalized on save, so new files are
// written clean, and on parse, so files already committed resolve too.
export function normalizeAnchorPath(path: string): string {
	return path
		.replaceAll("\\", "/")
		.split("/")
		.filter((segment) => segment !== "" && segment !== ".")
		.join("/");
}
