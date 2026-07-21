import { posix } from "node:path";
import type { ImportProvenance } from "@/domain";
import { TsconfigAliases } from "./tsconfig-aliases";

export interface ResolvedImport {
	toPath: string | null;
	provenance: ImportProvenance;
}

const UNRESOLVED: ResolvedImport = { toPath: null, provenance: "heuristic" };

const EXTENSION_TRIALS = [
	".ts",
	".tsx",
	".js",
	".jsx",
	".mts",
	".cts",
	".mjs",
	".cjs",
];

// NodeNext-style TS projects import "./x.js" for a source file "./x.ts".
const TYPESCRIPT_COUNTERPARTS = new Map<string, string[]>([
	[".js", [".ts", ".tsx"]],
	[".jsx", [".tsx"]],
	[".mjs", [".mts"]],
	[".cjs", [".cts"]],
]);

export class ImportResolver {
	static async create(
		repoRoot: string,
		files: Iterable<string>,
	): Promise<ImportResolver> {
		return new ImportResolver(
			new Set(files),
			await TsconfigAliases.load(repoRoot),
		);
	}

	private constructor(
		private readonly files: Set<string>,
		private readonly aliases: TsconfigAliases,
	) {}

	resolve(fromPath: string, specifier: string): ResolvedImport {
		if (specifier.startsWith("./") || specifier.startsWith("../")) {
			return this.resolveRelative(fromPath, specifier);
		}
		return this.resolveAliased(specifier);
	}

	private resolveRelative(fromPath: string, specifier: string): ResolvedImport {
		const base = posix.normalize(
			posix.join(posix.dirname(fromPath), specifier),
		);
		if (base.startsWith("..")) return UNRESOLVED;
		if (this.files.has(base)) return { toPath: base, provenance: "exact" };
		return { toPath: this.complete(base), provenance: "heuristic" };
	}

	private resolveAliased(specifier: string): ResolvedImport {
		for (const candidate of this.aliases.expand(specifier)) {
			const resolved = this.files.has(candidate)
				? candidate
				: this.complete(candidate);
			if (resolved) return { toPath: resolved, provenance: "heuristic" };
		}
		return UNRESOLVED;
	}

	private complete(base: string): string | null {
		return (
			this.completeCounterpart(base) ??
			this.completeExtension(base) ??
			this.completeExtension(`${base}/index`)
		);
	}

	private completeCounterpart(base: string): string | null {
		const extension = posix.extname(base);
		const stem = base.slice(0, base.length - extension.length);
		const counterparts = TYPESCRIPT_COUNTERPARTS.get(extension) ?? [];
		return this.firstExisting(counterparts.map((ext) => stem + ext));
	}

	private completeExtension(stem: string): string | null {
		return this.firstExisting(EXTENSION_TRIALS.map((ext) => stem + ext));
	}

	private firstExisting(candidates: string[]): string | null {
		return candidates.find((candidate) => this.files.has(candidate)) ?? null;
	}
}
