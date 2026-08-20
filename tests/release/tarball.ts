const BLOCK_SIZE = 512;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;

export interface TarMember {
	name: string;
	bytes: Uint8Array;
	// ustar's own vocabulary: "0" is a plain file, "5" a directory, "x" a pax
	// extension header. Overridable so the reader can be shown one it must
	// refuse.
	typeflag?: string;
	// The raw twelve-byte size field, when a test needs the header to declare
	// something other than the bytes that follow it.
	declaredSize?: Uint8Array;
}

// Mirrors what `tar --format=ustar` produces in scripts/package-release.ts, so
// tests can build archives with members the real packaging step would never
// emit (wrong name, several members, a 100-byte name with no terminator).
export function makeTarball(members: TarMember[]): Uint8Array<ArrayBuffer> {
	const blocks = members.flatMap((member) => [
		header(member),
		padded(member.bytes),
	]);
	return Bun.gzipSync(concat([...blocks, new Uint8Array(BLOCK_SIZE * 2)]));
}

function header(member: TarMember): Uint8Array {
	const block = new Uint8Array(BLOCK_SIZE).fill(0);
	writeText(block, member.name, 0);
	writeText(block, "000755\0 ", 100);
	writeSize(block, member);
	writeText(block, octal(0, 11), 136);
	writeText(block, " ".repeat(CHECKSUM_LENGTH), CHECKSUM_OFFSET);
	writeText(block, member.typeflag ?? "0", 156);
	writeText(block, "ustar\0" + "00", 257);
	// Six octal digits, a NUL and a space fill the field exactly; a byte more
	// would land on the typeflag that follows it.
	writeText(block, `${octal(checksum(block), 6)} `, CHECKSUM_OFFSET);
	return block;
}

function writeSize(block: Uint8Array, member: TarMember): void {
	if (member.declaredSize) {
		block.set(member.declaredSize, 124);
		return;
	}
	writeText(block, octal(member.bytes.length, 11), 124);
}

function checksum(block: Uint8Array): number {
	return block.reduce((total, byte) => total + byte, 0);
}

function octal(value: number, digits: number): string {
	return `${value.toString(8).padStart(digits, "0")}\0`;
}

function writeText(block: Uint8Array, text: string, offset: number): void {
	block.set(new TextEncoder().encode(text), offset);
}

function padded(bytes: Uint8Array): Uint8Array {
	const size = Math.ceil(bytes.length / BLOCK_SIZE) * BLOCK_SIZE;
	const block = new Uint8Array(size);
	block.set(bytes);
	return block;
}

function concat(blocks: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const total = blocks.reduce((size, block) => size + block.length, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const block of blocks) {
		joined.set(block, offset);
		offset += block.length;
	}
	return joined;
}
