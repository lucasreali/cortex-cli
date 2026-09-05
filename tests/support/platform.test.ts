import { describe, expect, test } from "bun:test";
import {
	RUNS_FROM_COMPILED_BINARY,
	RUNS_ON_WINDOWS,
	runsFromEmbeddedFilesystem,
} from "@/support/platform";

// The regression this pins cost a compiled Windows binary its identity: Bun
// spells the embedded filesystem "/$bunfs/" on POSIX and "B:\~BUN\root\" on
// Windows, and a check that knew only the first read an installed binary as a
// source checkout. That answer is what decides whether an environment variable
// may choose the origin cortex upgrades from and the program it executes, so
// the two spellings are pinned as examples rather than left to one substring.
describe("runsFromEmbeddedFilesystem", () => {
	const embedded = [
		"file:///$bunfs/root/cli/main.ts",
		"/$bunfs/root/embedding/worker.ts",
		"file:///B:/~BUN/root/cli/main.ts",
		"file:///C:/~BUN/root/release/target.ts",
	];
	for (const url of embedded) {
		test(`recognizes ${url}`, () => {
			expect(runsFromEmbeddedFilesystem(url)).toBe(true);
		});
	}

	const onDisk = [
		"file:///home/dev/cortex-cli/src/cli/main.ts",
		"file:///C:/repo/cortex-cli/src/cli/main.ts",
		// A directory a person named after the marker is still a real path: the
		// root Bun uses has separators on both sides of it.
		"file:///home/dev/~BUN/main.ts".replace("/~BUN/", "/~BUNX/"),
	];
	for (const url of onDisk) {
		test(`reads ${url} as a source checkout`, () => {
			expect(runsFromEmbeddedFilesystem(url)).toBe(false);
		});
	}
});

describe("what this process is", () => {
	test("the suite always runs from a checkout, never from the binary", () => {
		expect(RUNS_FROM_COMPILED_BINARY).toBe(false);
	});

	test("the Windows flag answers for this host", () => {
		expect(RUNS_ON_WINDOWS).toBe(process.platform === "win32");
	});
});
