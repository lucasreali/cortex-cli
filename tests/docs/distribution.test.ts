import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RELEASE_SUFFIXES } from "@/release/target";

const ROOT = new URL("../../", import.meta.url).pathname;
const doc = await Bun.file(join(ROOT, "docs", "distribution.md")).text();

const targets = [...doc.matchAll(/`bun-([a-z0-9-]+)`/g)].map(
	(match) => match[1] ?? "",
);

// The doc is where a reader learns what a release contains, and the list it
// describes lives in exactly one place in the code. Everything else — the
// packaging script, install.sh's detection, the upgrade path — already agrees
// with that list through a gate of its own; this is the prose's.
describe("docs/distribution.md describes the release that ships", () => {
	test("it names every target, and only real ones", () => {
		expect(targets.toSorted()).toEqual([...RELEASE_SUFFIXES].toSorted());
	});

	test("its asset count is a tarball and a sourcemap per target, plus checksums", () => {
		const claimed = doc.match(/carries (\d+) files/)?.[1];
		expect(Number(claimed)).toBe(RELEASE_SUFFIXES.length * 2 + 1);
	});
});
