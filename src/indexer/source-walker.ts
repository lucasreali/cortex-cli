import { type Dirent, readdirSync, type Stats, statSync } from "node:fs";
import { extname, join } from "node:path";
import { listRepoFiles } from "@/git";
import { CORTEX_DIRECTORY } from "@/storage/project-root";
import { errorMessage } from "@/support/errors";

// A dependency tree, the store's own directory and git's are never project
// source, whoever produced the listing.
const NEVER_SOURCE = new Set(["node_modules", CORTEX_DIRECTORY, ".git"]);

// `dist` and `build` are a guess about generated output, and a guess is only
// needed when nothing better answered. A git listing came with
// --exclude-standard, which already applied the project's own .gitignore — the
// authority on what is generated here — so applying the guess on top of it is
// what made a tracked `src/build/pipeline.ts` invisible to the index, to
// get_impact and, using the same filter, to doctor's drift check.
const PRESUMED_GENERATED = new Set(["dist", "build"]);

const WALK_EXCLUDED = new Set([...NEVER_SOURCE, ...PRESUMED_GENERATED]);

const MAX_PARSED_BYTES = 1024 * 1024;

const LANG_BY_EXTENSION = new Map([
	[".ts", "ts"],
	[".tsx", "tsx"],
	[".js", "js"],
	[".jsx", "jsx"],
	[".mts", "ts"],
	[".cts", "ts"],
	[".mjs", "js"],
	[".cjs", "js"],
]);

export interface SourceFile {
	path: string;
	lang: string;
	size: number;
	mtime: number;
	ctime: number;
}

// One entry per source file that will contribute no symbols, and why. A file is
// here whether or not it also made it into `files`: an oversized one still
// belongs to the resolver's file set, an unreadable one does not exist as far
// as this pass is concerned.
export interface SkippedSource {
	path: string;
	reason: string;
}

export interface SourceListing {
	files: SourceFile[];
	skipped: SkippedSource[];
}

export function listSources(root: string): SourceListing {
	return new SourceScan(root).listing();
}

// A file the walker cannot read is one file, not a broken repository: statSync
// throws ELOOP on a symlink cycle and EACCES under a chmod 000 directory, and
// readdirSync throws the same way. Letting either escape aborts the whole index
// — and, through checkCodeDrift, the whole doctor run.
class SourceScan {
	private readonly skipped: SkippedSource[] = [];

	constructor(private readonly root: string) {}

	listing(): SourceListing {
		const tracked = listRepoFiles(this.root);
		const excluded = tracked === null ? WALK_EXCLUDED : NEVER_SOURCE;
		const files = (tracked ?? this.walk(""))
			.filter((path) => hasNoExcludedSegment(path, excluded))
			.map((path) => this.toSourceFile(path))
			.filter((file): file is SourceFile => file !== null)
			.sort((a, b) => a.path.localeCompare(b.path));
		return { files, skipped: this.skipped };
	}

	private walk(prefix: string): string[] {
		return this.entriesOf(prefix).flatMap((entry) =>
			this.walkEntry(prefix, entry),
		);
	}

	private entriesOf(prefix: string): Dirent[] {
		try {
			return readdirSync(join(this.root, prefix), { withFileTypes: true });
		} catch (error) {
			this.skip(prefix === "" ? "." : prefix, errorMessage(error));
			return [];
		}
	}

	private walkEntry(prefix: string, entry: Dirent): string[] {
		const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (!entry.isDirectory()) return [path];
		if (WALK_EXCLUDED.has(entry.name)) return [];
		return this.walk(path);
	}

	private toSourceFile(path: string): SourceFile | null {
		const lang = LANG_BY_EXTENSION.get(extname(path));
		if (!lang) return null;
		const stats = this.statsOf(path);
		if (!stats) return null;
		this.skipIfOversized(path, stats.size);
		return {
			path,
			lang,
			size: stats.size,
			mtime: Math.floor(stats.mtimeMs),
			ctime: Math.floor(stats.ctimeMs),
		};
	}

	// A tracked file that is no longer on disk is an ordinary listing, not a
	// failure, so ENOENT stays silent while every other errno is reported.
	private statsOf(path: string): Stats | null {
		try {
			return statSync(join(this.root, path), { throwIfNoEntry: false }) ?? null;
		} catch (error) {
			this.skip(path, errorMessage(error));
			return null;
		}
	}

	// Too large to parse, but still a file an import can point at: dropping it
	// from the listing is what left every import to a large generated module
	// unresolved, with doctor reporting a low resolution rate and no cause.
	private skipIfOversized(path: string, size: number): void {
		if (size <= MAX_PARSED_BYTES) return;
		this.skip(path, `larger than the ${MAX_PARSED_BYTES}-byte parse limit`);
	}

	private skip(path: string, reason: string): void {
		this.skipped.push({ path, reason });
	}
}

function hasNoExcludedSegment(path: string, excluded: Set<string>): boolean {
	return !path.split("/").some((segment) => excluded.has(segment));
}
