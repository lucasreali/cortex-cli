const BLOCK_SIZE = 512;
const NAME_LENGTH = 100;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const TYPEFLAG_OFFSET = 156;
const BASE_256_MARKER = 0x80;
const MEMBER = "cortex";

// ustar spells a plain file "0", and the original tar format spells it with a
// NUL. Anything else — a directory, a link, a device — is not an executable to
// unpack, and the extension headers ("x", "g", "L", "K") carry a name or size
// that overrides the block after them, which this reader does not honor: it has
// to refuse them rather than read the header they were meant to correct.
const REGULAR_FILE = new Set(["0", "\0"]);

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
		if (content + size > tar.length) {
			throw new Error("the release archive ends inside one of its members");
		}
		if (name === MEMBER) return regularFile(tar, offset, content, size);
		offset = content + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
	}
	throw new Error(
		`the release archive does not contain a ${MEMBER} executable`,
	);
}

function regularFile(
	tar: Uint8Array<ArrayBuffer>,
	offset: number,
	content: number,
	size: number,
): Uint8Array<ArrayBuffer> {
	if (REGULAR_FILE.has(typeflag(tar, offset))) {
		return tar.slice(content, content + size);
	}
	throw new Error(`the ${MEMBER} member of the release archive is not a file`);
}

function typeflag(tar: Uint8Array, offset: number): string {
	const start = offset + TYPEFLAG_OFFSET;
	return decode(tar.subarray(start, start + 1));
}

function readName(tar: Uint8Array, offset: number): string {
	const field = tar.subarray(offset, offset + NAME_LENGTH);
	const terminator = field.indexOf(0);
	if (terminator === -1) return decode(field);
	return decode(field.subarray(0, terminator));
}

// A size is octal digits in a fixed field, so anything else — a corrupt
// header, GNU's base-256 encoding for sizes past 8 GB, a field of spaces —
// parses to NaN or worse and would otherwise be read as an empty member and
// installed as a zero-byte cortex.
function readSize(tar: Uint8Array, offset: number): number {
	const start = offset + SIZE_OFFSET;
	const field = tar.subarray(start, start + SIZE_LENGTH);
	const size = Number.parseInt(decode(field).replace(/\0/g, "").trim(), 8);
	if (Number.isSafeInteger(size) && size >= 0 && !isBase256(field)) return size;
	throw new Error("the release archive declares a member size it cannot have");
}

function isBase256(field: Uint8Array): boolean {
	return ((field[0] ?? 0) & BASE_256_MARKER) !== 0;
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
