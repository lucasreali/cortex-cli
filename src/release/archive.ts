const BLOCK_SIZE = 512;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const MEMBER = "cortex";

// scripts/package-release.ts writes a ustar archive holding exactly one
// member, so reading it here costs less than depending on a tar binary being
// installed — the binary ships with no runtime dependencies and the upgrade
// path keeps that promise.
export function readCortexBinary(
	tarball: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
	return findMember(gunzip(tarball));
}

function gunzip(tarball: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	try {
		return Bun.gunzipSync(tarball);
	} catch {
		throw new Error("the release archive is not a valid gzip stream");
	}
}

function findMember(tar: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	let offset = 0;
	while (offset + BLOCK_SIZE <= tar.length) {
		const name = readName(tar, offset);
		if (name === "") break;
		const size = readSize(tar, offset);
		const content = offset + BLOCK_SIZE;
		if (name === MEMBER) return tar.slice(content, content + size);
		offset = content + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
	}
	throw new Error(
		`the release archive does not contain a ${MEMBER} executable`,
	);
}

function readName(tar: Uint8Array, offset: number): string {
	const field = tar.subarray(offset, offset + NAME_LENGTH);
	const terminator = field.indexOf(0);
	if (terminator === -1) return decode(field);
	return decode(field.subarray(0, terminator));
}

function readSize(tar: Uint8Array, offset: number): number {
	const start = offset + SIZE_OFFSET;
	const field = decode(tar.subarray(start, start + SIZE_LENGTH));
	return Number.parseInt(field.replace(/\0/g, "").trim(), 8);
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
