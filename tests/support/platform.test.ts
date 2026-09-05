import { describe, expect, test } from "bun:test";
import {
	RUNS_FROM_COMPILED_BINARY,
	RUNS_ON_WINDOWS,
	runsFromEmbeddedFilesystem,
} from "@/support/platform";

// The regression this pins cost a compiled Windows binary its identity, and it
// cost it twice: Bun roots the embedded filesystem at /$bunfs/ on POSIX and at
// /~BUN/ on Windows, and on Windows the tilde reaches import.meta.url
// percent-encoded — so neither "$bunfs" nor a literal "~BUN" appears in the
// string. Both strings below are copied from a binary compiled for each
// platform and run, which is the only place they can be read from.
describe("runsFromEmbeddedFilesystem", () => {
	const embedded = [
		// Verbatim from a compiled binary of each target.
		"file:///$bunfs/root/cortex",
		"file:///B:/%7EBUN/root/cortex.exe",
		// The same two, spelled the ways a future Bun might hand them over.
		"file:///B:/~BUN/root/cortex.exe",
		"file:///b:/%7ebun/root/cortex.exe".replace("%7ebun", "%7EBUN"),
		"/$bunfs/root/embedding/worker.ts",
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
		"file:///home/dev/~BUNX/main.ts",
		"file:///home/dev/bunfs/main.ts",
		// A malformed escape must be compared raw, not thrown from: this runs
		// at module load, in front of every command.
		"file:///home/dev/100%/main.ts",
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
