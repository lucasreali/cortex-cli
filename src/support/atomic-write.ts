import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readlinkSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { errnoCode } from "./errors";

type WritableSource = Blob | NodeJS.TypedArray | ArrayBufferLike | string;

const PERMISSION_BITS = 0o777;

// Linux stops following links after 40 hops; matching it ends a symlink cycle
// here instead of spinning.
const MAXIMUM_LINK_HOPS = 40;

// O_EXCL: the staging path is derived from the target and therefore guessable,
// and every path-based write follows a symlink sitting at it — which would put
// our bytes, and then our chmod, wherever the link pointed. Creating the file
// exclusively refuses that outright. The mode is the one Bun.write used, so a
// brand new file is still the umask's to decide.
const STAGING_FLAGS = "wx";
const STAGING_MODE = 0o666;

// rename is atomic on the same filesystem, so a concurrent reader observes
// either the previous file or the complete new one, never a partial write.
export async function writeAtomically(
	targetPath: string,
	source: WritableSource,
): Promise<void> {
	const destination = linkTarget(targetPath);
	publish(await stage(destination, source), destination);
}

// rename cannot compare-and-swap, so atomicity says nothing about a
// read-modify-write: ~/.claude.json is rewritten continuously by the session
// running the install, and publishing a copy rendered before that rewrite
// reverts it. Re-reading the destination once the staging file is complete
// narrows the window to the rename itself. `expected` is null for a file the
// caller believes is not there yet, and a caller told false lost the race and
// can read again and redo its merge.
export async function writeAtomicallyIfUnchanged(
	targetPath: string,
	source: WritableSource,
	expected: string | null,
): Promise<boolean> {
	const destination = linkTarget(targetPath);
	const staging = await stage(destination, source);
	if ((await contentOrNull(destination)) !== expected) {
		unlinkSync(staging);
		return false;
	}
	publish(staging, destination);
	return true;
}

async function stage(
	destination: string,
	source: WritableSource,
): Promise<string> {
	const staging = stagingPath(destination);
	const handle = createStagingFile(staging);
	try {
		await Bun.write(Bun.file(handle), source);
	} finally {
		closeSync(handle);
	}
	return staging;
}

async function contentOrNull(path: string): Promise<string | null> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : null;
}

// The synchronous twin exists for callers that write inside a bun:sqlite
// transaction, which cannot survive an await without letting another writer
// interleave. It must stay behaviorally identical to the async one.
export function writeAtomicallySync(targetPath: string, source: string): void {
	const destination = linkTarget(targetPath);
	const staging = stagingPath(destination);
	const handle = createStagingFile(staging);
	try {
		writeFileSync(handle, source);
	} finally {
		closeSync(handle);
	}
	publish(staging, destination);
}

export function stagingPath(targetPath: string): string {
	return `${targetPath}.${process.pid}${STAGING_SUFFIX}`;
}

const STAGING_SUFFIX = ".partial";

// Nothing collects a staging file a killed process left behind, so a directory
// that is committed — `.cortex/decisions/` — needs to recognize one to report
// it. The suffix is this module's to name, not a string for a reader to match.
export function stagingSuffix(): string {
	return STAGING_SUFFIX;
}

export function createStagingFile(path: string): number {
	try {
		return openSync(path, STAGING_FLAGS, STAGING_MODE);
	} catch (error) {
		return afterClearingTheWay(error, path);
	}
}

// The two things Bun.write did on its own and an exclusive open will not: make
// the directory a caller expects to be created for it, and take over a staging
// file left behind by a process that died mid-write — or by a pid the kernel
// has since handed out again — which would otherwise disable every later write
// to this path. Retrying is safe where overwriting would not be: the second
// attempt is exclusive too, so anything planted in between fails the open
// rather than being written through.
function afterClearingTheWay(error: unknown, path: string): number {
	const code = errnoCode(error);
	if (code === "EEXIST") return replacingLeftover(path);
	if (code === "ENOENT") return inNewDirectory(path);
	throw error;
}

function replacingLeftover(path: string): number {
	unlinkSync(path);
	return openSync(path, STAGING_FLAGS, STAGING_MODE);
}

function inNewDirectory(path: string): number {
	mkdirSync(dirname(path), { recursive: true });
	return openSync(path, STAGING_FLAGS, STAGING_MODE);
}

function publish(staging: string, destination: string): void {
	adoptMode(destination, staging);
	renameSync(staging, destination);
}

// Writing through a symlink rather than over it keeps the worktree and
// shared-output setups that link a file elsewhere working, and it puts the
// staging file beside the real target — rename is only atomic within one
// filesystem. A path that is not a link, or is not there yet, is its own target.
function linkTarget(path: string): string {
	let current = path;
	for (let hop = 0; hop < MAXIMUM_LINK_HOPS; hop += 1) {
		const link = readLinkOrNull(current);
		if (link === null) return current;
		current = resolve(dirname(current), link);
	}
	return current;
}

function readLinkOrNull(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

// A fresh staging file carries the process umask, so replacing a destination
// someone widened would silently tighten it back to owner-only. Both failures
// mean the same thing — leave the umask default alone: an absent destination
// has no mode to inherit, and a chmod we are not permitted to make must not
// fail a write that would otherwise succeed.
function adoptMode(destination: string, staging: string): void {
	try {
		chmodSync(staging, statSync(destination).mode & PERMISSION_BITS);
	} catch {
		return;
	}
}
