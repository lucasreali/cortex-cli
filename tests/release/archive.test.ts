import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCortexBinary } from "@/release/archive";
import { makeTarball } from "./tarball";

// Deliberately not a multiple of 512: the reader has to honor the size field
// rather than the block padding around it.
const BINARY = new TextEncoder().encode("#!/bin/sh\necho compiled-cortex\n");

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cortex-release-"));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("readCortexBinary", () => {
	// The archive cortex actually ships is written by the tar binary with these
	// flags (scripts/package-release.ts), so the reader is pinned against it and
	// not only against the test's own writer.
	test("reads a member out of an archive real tar produced", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "cortex"), BINARY);
		writeFileSync(join(dir, "LICENSE"), "MIT License\n");
		writeFileSync(join(dir, "THIRD-PARTY-NOTICES.md"), "# Notices\n");
		const tar = Bun.spawnSync(
			[
				"tar",
				"--format=ustar",
				"-cf",
				"-",
				"-C",
				dir,
				"cortex",
				"LICENSE",
				"THIRD-PARTY-NOTICES.md",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(tar.exitCode).toBe(0);
		const tarball = Bun.gzipSync(new Uint8Array(tar.stdout));
		expect(readCortexBinary(tarball)).toEqual(BINARY);
	});

	test("finds the member behind another one", () => {
		const tarball = makeTarball([
			{ name: "readme.txt", bytes: new TextEncoder().encode("ignored") },
			{ name: "cortex", bytes: BINARY },
		]);
		expect(readCortexBinary(tarball)).toEqual(BINARY);
	});

	// A 100-byte name fills the field with no room for a terminator.
	test("reads names that fill the whole name field", () => {
		const tarball = makeTarball([
			{ name: "n".repeat(100), bytes: BINARY },
			{ name: "cortex", bytes: BINARY },
		]);
		expect(readCortexBinary(tarball)).toEqual(BINARY);
	});

	test("rejects an archive without a cortex member", () => {
		const tarball = makeTarball([{ name: "cortexx", bytes: BINARY }]);
		expect(() => readCortexBinary(tarball)).toThrow(
			"does not contain a cortex executable",
		);
	});

	test("rejects an empty archive", () => {
		expect(() => readCortexBinary(makeTarball([]))).toThrow(
			"does not contain a cortex executable",
		);
	});

	// A size field that is not octal parses to NaN, which sliced to nothing and
	// installed a zero-byte cortex over the working one.
	test("rejects a member whose size is not a number", () => {
		const tarball = makeTarball([
			{
				name: "cortex",
				bytes: BINARY,
				declaredSize: new TextEncoder().encode("not-octal\0  "),
			},
		]);
		expect(() => readCortexBinary(tarball)).toThrow(
			"declares a member size it cannot have",
		);
	});

	// GNU writes sizes past 8 GB as base 256, marked by the high bit of the
	// first byte, and parseInt reads that field as a small octal number.
	test("rejects a size this reader cannot decode", () => {
		const declaredSize = new Uint8Array(12);
		declaredSize[0] = 0x80;
		declaredSize[11] = 0x01;
		const tarball = makeTarball([
			{ name: "cortex", bytes: BINARY, declaredSize },
		]);
		expect(() => readCortexBinary(tarball)).toThrow(
			"declares a member size it cannot have",
		);
	});

	test("rejects an archive that ends inside the member it declares", () => {
		const tarball = makeTarball([
			{
				name: "cortex",
				bytes: BINARY,
				declaredSize: new TextEncoder().encode("00000200000\0"),
			},
		]);
		expect(() => readCortexBinary(tarball)).toThrow(
			"ends inside one of its members",
		);
	});

	// A pax or GNU extension header carries the name and size of the block
	// after it. This reader honors neither, so it must refuse the header rather
	// than unpack the block the header was there to correct.
	test("rejects a cortex member that is not a plain file", () => {
		for (const typeflag of ["5", "2", "x", "L"]) {
			const tarball = makeTarball([
				{ name: "cortex", bytes: BINARY, typeflag },
			]);
			expect(() => readCortexBinary(tarball)).toThrow("is not a file");
		}
	});

	test("reads the member the original tar format leaves unflagged", () => {
		const tarball = makeTarball([
			{ name: "cortex", bytes: BINARY, typeflag: "\0" },
		]);
		expect(readCortexBinary(tarball)).toEqual(BINARY);
	});

	test("rejects a download that is not a gzip stream at all", () => {
		const html = new TextEncoder().encode("<html>404</html>");
		expect(() => readCortexBinary(html)).toThrow(
			"the release archive is not a valid gzip stream",
		);
	});
});
