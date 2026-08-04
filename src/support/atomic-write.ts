import { renameSync, writeFileSync } from "node:fs";

type WritableSource = Blob | NodeJS.TypedArray | ArrayBufferLike | string;

// rename is atomic on the same filesystem, so a concurrent reader observes
// either the previous file or the complete new one, never a partial write.
export async function writeAtomically(
	targetPath: string,
	source: WritableSource,
): Promise<void> {
	const staging = stagingPath(targetPath);
	await Bun.write(staging, source);
	renameSync(staging, targetPath);
}

// The synchronous twin exists for callers that write inside a bun:sqlite
// transaction, which cannot survive an await without letting another writer
// interleave.
export function writeAtomicallySync(targetPath: string, source: string): void {
	const staging = stagingPath(targetPath);
	writeFileSync(staging, source);
	renameSync(staging, targetPath);
}

function stagingPath(targetPath: string): string {
	return `${targetPath}.${process.pid}.partial`;
}
