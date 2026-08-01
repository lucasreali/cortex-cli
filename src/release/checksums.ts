import { sha256Hex } from "@/support/hash";

// checksums.txt covers every platform's asset, so a release is only trusted
// through the one line naming the asset we downloaded — the same discipline
// install.sh applies with awk.
export class Checksums {
	private readonly digests: Map<string, string>;

	constructor(text: string) {
		this.digests = new Map(
			text
				.split("\n")
				.map((line) => line.trim().split(/\s+/))
				.filter((fields) => fields.length === 2)
				.map(([digest, asset]) => [String(asset), String(digest)]),
		);
	}

	verify(asset: string, bytes: Uint8Array): void {
		const expected = this.expect(asset);
		const actual = sha256Hex(bytes);
		if (expected === actual) return;
		throw new Error(
			`checksum mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`,
		);
	}

	private expect(asset: string): string {
		const digest = this.digests.get(asset);
		if (digest) return digest;
		throw new Error(`${asset} is not listed in checksums.txt`);
	}
}
