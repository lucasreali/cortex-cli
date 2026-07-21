import { join, posix } from "node:path";

interface AliasPattern {
	key: string;
	targets: string[];
}

interface RawCompilerOptions {
	baseUrl?: unknown;
	paths?: unknown;
}

export class TsconfigAliases {
	static async load(repoRoot: string): Promise<TsconfigAliases> {
		const options = await readCompilerOptions(join(repoRoot, "tsconfig.json"));
		return new TsconfigAliases(baseUrlOf(options), patternsOf(options));
	}

	constructor(
		private readonly baseUrl: string | null,
		private readonly patterns: AliasPattern[],
	) {}

	expand(specifier: string): string[] {
		const viaPatterns = this.patterns.flatMap((pattern) =>
			this.substitute(pattern, specifier),
		);
		const viaBaseUrl =
			this.baseUrl === null ? [] : [posix.join(this.baseUrl, specifier)];
		return [...viaPatterns, ...viaBaseUrl]
			.map((candidate) => posix.normalize(candidate))
			.filter(
				(candidate) =>
					!candidate.startsWith("..") && !posix.isAbsolute(candidate),
			);
	}

	private substitute(pattern: AliasPattern, specifier: string): string[] {
		const star = pattern.key.indexOf("*");
		if (star < 0) {
			if (pattern.key !== specifier) return [];
			return pattern.targets.map((target) => this.fromBase(target));
		}
		const prefix = pattern.key.slice(0, star);
		const suffix = pattern.key.slice(star + 1);
		if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
		if (specifier.length < prefix.length + suffix.length) return [];
		const middle = specifier.slice(
			prefix.length,
			specifier.length - suffix.length,
		);
		return pattern.targets.map((target) =>
			this.fromBase(target.replace("*", middle)),
		);
	}

	private fromBase(target: string): string {
		return posix.join(this.baseUrl ?? "", target);
	}
}

async function readCompilerOptions(path: string): Promise<RawCompilerOptions> {
	try {
		const module = await import(path, { with: { type: "jsonc" } });
		return (
			(module.default as { compilerOptions?: RawCompilerOptions })
				.compilerOptions ?? {}
		);
	} catch {
		return {};
	}
}

function baseUrlOf(options: RawCompilerOptions): string | null {
	if (typeof options.baseUrl !== "string") return null;
	const normalized = posix.normalize(options.baseUrl);
	return normalized === "." ? "" : normalized;
}

function patternsOf(options: RawCompilerOptions): AliasPattern[] {
	if (typeof options.paths !== "object" || options.paths === null) return [];
	return Object.entries(options.paths)
		.filter(([, targets]) => Array.isArray(targets))
		.map(([key, targets]) => ({
			key,
			targets: (targets as unknown[]).filter(
				(target): target is string => typeof target === "string",
			),
		}));
}
