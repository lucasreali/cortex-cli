import {
	chmodSync,
	readlinkSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

type WritableSource = Blob | NodeJS.TypedArray | ArrayBufferLike | string;

const PERMISSION_BITS = 0o777;

// Linux stops following links after 40 hops; matching it ends a symlink cycle
// here instead of spinning.
const MAXIMUM_LINK_HOPS = 40;

// rename is atomic on the same filesystem, so a concurrent reader observes
// either the previous file or the complete new one, never a partial write.
export async function writeAtomically(
	targetPath: string,
	source: WritableSource,
): Promise<void> {
	const destination = linkTarget(targetPath);
	const staging = stagingPath(destination);
	await Bun.write(staging, source);
	publish(staging, destination);
}

// The synchronous twin exists for callers that write inside a bun:sqlite
// transaction, which cannot survive an await without letting another writer
// interleave. It must stay behaviorally identical to the async one.
export function writeAtomicallySync(targetPath: string, source: string): void {
	const destination = linkTarget(targetPath);
	const staging = stagingPath(destination);
	writeFileSync(staging, source);
	publish(staging, destination);
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

function stagingPath(targetPath: string): string {
	return `${targetPath}.${process.pid}.partial`;
}
