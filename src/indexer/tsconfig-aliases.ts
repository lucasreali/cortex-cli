import { existsSync, readFileSync } from "node:fs";
import {
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	resolve,
	sep,
} from "node:path";

interface AliasPattern {
	key: string;
	targets: string[];
}

interface RawCompilerOptions {
	baseUrl?: unknown;
	paths?: unknown;
}

interface RawTsconfig {
	extends?: unknown;
	compilerOptions?: RawCompilerOptions;
}

// One tsconfig of an `extends` chain, carrying the directory its own relative
// paths were written against: the same `"baseUrl": "."` means the repo root in
// the root config and a package directory in a per-package one, so a layer
// without its directory cannot be interpreted.
interface ConfigLayer {
	directory: string;
	options: RawCompilerOptions;
}

export class TsconfigAliases {
	// Synchronous like the rest of the walk it feeds: an `extends` chain is a
	// handful of small files, read once per pass, beside a stat of every source
	// file in the repository.
	static load(repoRoot: string): TsconfigAliases {
		const layers = collectLayers(join(repoRoot, "tsconfig.json"));
		const baseUrl = declaredBaseUrl(layers);
		return new TsconfigAliases(
			baseUrl === null ? null : repoRelative(repoRoot, baseUrl),
			declaredPatterns(repoRoot, layers, baseUrl),
		);
	}

	constructor(
		private readonly baseUrl: string | null,
		private readonly patterns: AliasPattern[],
	) {}

	expand(specifier: string): string[] {
		const viaPatterns = this.patterns.flatMap((pattern) =>
			substitute(pattern, specifier),
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
}

function substitute(pattern: AliasPattern, specifier: string): string[] {
	const star = pattern.key.indexOf("*");
	if (star < 0) {
		if (pattern.key !== specifier) return [];
		return pattern.targets;
	}
	const prefix = pattern.key.slice(0, star);
	const suffix = pattern.key.slice(star + 1);
	if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return [];
	if (specifier.length < prefix.length + suffix.length) return [];
	const middle = specifier.slice(
		prefix.length,
		specifier.length - suffix.length,
	);
	return pattern.targets.map((target) => target.replace("*", middle));
}

function collectLayers(path: string): ConfigLayer[] {
	return visit(path, new Set());
}

// Depth first and most-derived first, so "the nearest layer that spells this
// key wins" is a `find` — which is exactly how tsc merges compilerOptions. The
// visited set is what makes a cycle in the chain terminate.
function visit(path: string, visited: Set<string>): ConfigLayer[] {
	if (visited.has(path)) return [];
	visited.add(path);
	const config = readConfig(path);
	if (config === null) return [];
	const directory = dirname(path);
	const inherited = parentsOf(config, directory).flatMap((parent) =>
		visit(parent, visited),
	);
	return [{ directory, options: config.compilerOptions ?? {} }, ...inherited];
}

// Read as bytes rather than through `import(...)`: a config the ESM cache
// already holds would otherwise survive an edit for the life of the process,
// which for the MCP server means until a restart.
function readConfig(path: string): RawTsconfig | null {
	try {
		const parsed: unknown = Bun.JSONC.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		return parsed as RawTsconfig;
	} catch {
		return null;
	}
}

// A later entry of an `extends` array overrides an earlier one, so the array is
// walked backwards into a list whose head has the highest priority.
function parentsOf(config: RawTsconfig, directory: string): string[] {
	return extendsList(config.extends)
		.reverse()
		.map((specifier) => resolveExtends(specifier, directory))
		.filter((path): path is string => path !== null);
}

function extendsList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function resolveExtends(specifier: string, directory: string): string | null {
	if (specifier.startsWith(".") || isAbsolute(specifier)) {
		return withJsonSuffix(resolve(directory, specifier));
	}
	return packageConfig(specifier, directory);
}

function withJsonSuffix(path: string): string {
	return path.endsWith(".json") ? path : `${path}.json`;
}

// A bare `extends` names a package, which tsc resolves the way node would:
// upward through node_modules, falling back to the package's `tsconfig.json`
// when the specifier names no file of its own.
function packageConfig(specifier: string, directory: string): string | null {
	const candidates = ancestorsOf(directory).map((root) =>
		withPackageDefault(join(root, "node_modules", specifier)),
	);
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function withPackageDefault(path: string): string {
	return path.endsWith(".json") ? path : join(path, "tsconfig.json");
}

function ancestorsOf(directory: string): string[] {
	const parent = dirname(directory);
	if (parent === directory) return [directory];
	return [directory, ...ancestorsOf(parent)];
}

function declaredBaseUrl(layers: ConfigLayer[]): string | null {
	const layer = layers.find(
		(candidate) => typeof candidate.options.baseUrl === "string",
	);
	if (!layer) return null;
	return resolve(layer.directory, layer.options.baseUrl as string);
}

// Since TypeScript 4.1 a `paths` map without a `baseUrl` is read against the
// directory of the file that spells it, which is the only reading that makes an
// inherited map mean the same thing from every package in a monorepo.
function declaredPatterns(
	repoRoot: string,
	layers: ConfigLayer[],
	baseUrl: string | null,
): AliasPattern[] {
	const layer = layers.find((candidate) => isMap(candidate.options.paths));
	if (!layer) return [];
	const base = baseUrl ?? layer.directory;
	return Object.entries(layer.options.paths as Record<string, unknown>)
		.filter(([, targets]) => Array.isArray(targets))
		.map(([key, targets]) => ({
			key,
			targets: (targets as unknown[])
				.filter((target): target is string => typeof target === "string")
				.map((target) => repoRelative(repoRoot, resolve(base, target))),
		}));
}

function isMap(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repoRelative(repoRoot: string, path: string): string {
	return relative(repoRoot, path).split(sep).join("/");
}
