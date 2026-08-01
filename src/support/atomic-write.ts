import { renameSync } from "node:fs";

type WritableSource = Blob | NodeJS.TypedArray | ArrayBufferLike | string;

// rename is atomic on the same filesystem, so a concurrent reader observes
// either the previous file or the complete new one, never a partial write.
export async function writeAtomically(
	targetPath: string,
	source: WritableSource,
): Promise<void> {
	const staging = `${targetPath}.${process.pid}.partial`;
	await Bun.write(staging, source);
	renameSync(staging, targetPath);
}
