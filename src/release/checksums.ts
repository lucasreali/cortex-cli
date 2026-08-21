import { sha256Hex } from "@/support/hash";

// checksums.txt covers every platform's asset, so a release is only trusted
// through the one line naming the asset we downloaded — the same discipline
// install.sh applies with awk.
export class Checksums {
	private readonly digests: Map<string, string>;

	constructor(text: string) {
		this.digests = new Map();
		for (const fields of Checksums.entries(text)) {
			this.claim(String(fields[1]), String(fields[0]));
		}
	}

	private static entries(text: string): string[][] {
		return text
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((fields) => fields.length === 2);
	}

	// A second line for one asset is an ambiguous listing, never a fact, so it
	// is refused rather than resolved: a Map would take the last one silently
	// while install.sh's awk collects every match and fails the comparison, and
	// the two verifiers must not disagree about which bytes a release names.
	private claim(asset: string, digest: string): void {
		if (!this.digests.has(asset)) {
			this.digests.set(asset, digest);
			return;
		}
		throw new Error(`${asset} is listed more than once in checksums.txt`);
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
