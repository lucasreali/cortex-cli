import { symbolKey } from "@/support/symbol-key";

export interface SymbolLocation {
	filePath: string;
	kind: string;
	line: number;
}

export interface LocatedSymbolRow {
	file_path: string;
	kind: string;
	line: number;
	name: string;
}

// The symbol table read once, keyed by the one recipe. SQLite cannot run that
// recipe, so answering "where else does this name live?" costs a scan and a
// normalize per row — a price a caller with many anchors to grade pays once
// here instead of once per anchor.
export class SymbolTable {
	private readonly byKey = new Map<string, SymbolLocation[]>();

	constructor(rows: LocatedSymbolRow[]) {
		for (const row of rows) {
			this.record(symbolKey(row.name), {
				filePath: row.file_path,
				kind: row.kind,
				line: row.line,
			});
		}
	}

	locationsOf(name: string): SymbolLocation[] {
		return this.byKey.get(symbolKey(name)) ?? [];
	}

	private record(key: string, location: SymbolLocation): void {
		const known = this.byKey.get(key);
		if (known) {
			known.push(location);
			return;
		}
		this.byKey.set(key, [location]);
	}
}
