import { type Dirent, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { listRepoFiles } from "@/git";
import { CORTEX_DIRECTORY } from "@/storage/project-root";

const EXCLUDED_DIRECTORIES = new Set([
	"node_modules",
	"dist",
	"build",
	CORTEX_DIRECTORY,
	".git",
]);

const MAX_FILE_BYTES = 1024 * 1024;

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
}

export function listSourceFiles(root: string): SourceFile[] {
	const candidates = listRepoFiles(root) ?? walkDirectory(root, "");
	return candidates
		.filter(hasNoExcludedSegment)
		.map((path) => toSourceFile(root, path))
		.filter((file): file is SourceFile => file !== null)
		.sort((a, b) => a.path.localeCompare(b.path));
}

function hasNoExcludedSegment(path: string): boolean {
	return !path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment));
}

function toSourceFile(root: string, path: string): SourceFile | null {
	const lang = LANG_BY_EXTENSION.get(extname(path));
	if (!lang) return null;
	const stats = statSync(join(root, path), { throwIfNoEntry: false });
	if (!stats || stats.size > MAX_FILE_BYTES) return null;
	return { path, lang, size: stats.size, mtime: Math.floor(stats.mtimeMs) };
}

function walkDirectory(root: string, prefix: string): string[] {
	const entries = readdirSync(join(root, prefix), { withFileTypes: true });
	return entries.flatMap((entry) => walkEntry(root, prefix, entry));
}

function walkEntry(root: string, prefix: string, entry: Dirent): string[] {
	const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
	if (!entry.isDirectory()) return [path];
	if (EXCLUDED_DIRECTORIES.has(entry.name)) return [];
	return walkDirectory(root, path);
}
