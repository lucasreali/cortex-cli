import { describe, expect, test } from "bun:test";
import { Checksums } from "@/release/checksums";
import { sha256Hex } from "@/support/hash";

const ASSET = "cortex-v0.2.0-linux-x64.tar.gz";
const BYTES = new TextEncoder().encode("pretend-tarball");

function listing(entries: Array<[string, string]>): string {
	return `${entries.map(([digest, name]) => `${digest}  ${name}`).join("\n")}\n`;
}

describe("Checksums", () => {
	test("accepts an asset whose digest matches its line", () => {
		const checksums = new Checksums(listing([[sha256Hex(BYTES), ASSET]]));
		expect(() => checksums.verify(ASSET, BYTES)).not.toThrow();
	});

	test("reports both digests when the download does not match", () => {
		const checksums = new Checksums(listing([["a".repeat(64), ASSET]]));
		expect(() => checksums.verify(ASSET, BYTES)).toThrow(
			/checksum mismatch for .*expected a{64}.*actual/s,
		);
	});

	test("refuses an asset the release does not list", () => {
		const checksums = new Checksums(
			listing([[sha256Hex(BYTES), "other.tar.gz"]]),
		);
		expect(() => checksums.verify(ASSET, BYTES)).toThrow(
			`${ASSET} is not listed in checksums.txt`,
		);
	});

	// install.sh's awk prints every matching line, so a duplicated asset makes
	// its comparison fail. A Map here would take the last line instead, and a
	// listing that installs one way and upgrades another is worse than one that
	// is refused by both.
	test("refuses a listing that names one asset twice", () => {
		expect(
			() =>
				new Checksums(
					listing([
						["a".repeat(64), ASSET],
						["b".repeat(64), ASSET],
					]),
				),
		).toThrow(`${ASSET} is listed more than once in checksums.txt`);
	});

	test("refuses a duplicate even when both lines agree", () => {
		const digest = sha256Hex(BYTES);
		expect(
			() =>
				new Checksums(
					listing([
						[digest, ASSET],
						[digest, ASSET],
					]),
				),
		).toThrow("listed more than once");
	});

	// checksums.txt covers every platform plus the sourcemap, so the parser has
	// to survive blank lines and pick the exact asset, not a prefix of one.
	test("ignores blank lines and distinguishes assets sharing a prefix", () => {
		const musl = `${ASSET.replace(".tar.gz", "")}-musl.tar.gz`;
		const checksums = new Checksums(
			`\n${listing([
				["b".repeat(64), musl],
				[sha256Hex(BYTES), ASSET],
			])}\n   \n`,
		);
		expect(() => checksums.verify(ASSET, BYTES)).not.toThrow();
		expect(() => checksums.verify(musl, BYTES)).toThrow("checksum mismatch");
	});
});
