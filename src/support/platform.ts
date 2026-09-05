// Whether this process runs on Windows, as a value rather than a check made
// three times over. Every consumer takes it as a default parameter instead of
// reading process.platform for itself: the branch a given host cannot reach is
// still a branch the suite has to drive, and a constant read inline is one no
// test can enter.
export const RUNS_ON_WINDOWS: boolean = process.platform === "win32";

// Bun serves every module inside a compiled binary from an embedded
// filesystem, and roots it differently per platform. Measured, not guessed —
// a binary compiled for each and then run:
//
//   linux    file:///$bunfs/root/cortex
//   windows  file:///B:/%7EBUN/root/cortex.exe
//
// Two things bite. The Windows root is a different name, and its tilde
// arrives percent-encoded, so a literal "~BUN" does not appear in the string
// at all — which is why the first attempt at this fix still read a compiled
// Windows binary as a source checkout. The URL is therefore decoded before it
// is matched, and a malformed escape is compared raw rather than throwing:
// this runs at module load, in front of every command.
//
// That answer decides whether an environment variable may choose the origin
// cortex upgrades from and the program it executes, and how the binary reaches
// its own hidden subcommands — so a wrong one costs the worker, the daemon and
// the git hooks as well as the two seams.
//
// The drive letter is not pinned: only Bun chooses it, and the root is
// distinctive without it.
const EMBEDDED_FILESYSTEM_ROOTS = ["/$bunfs/", "/~BUN/"];

export function runsFromEmbeddedFilesystem(moduleUrl: string): boolean {
	const path = decodedOrRaw(moduleUrl);
	return EMBEDDED_FILESYSTEM_ROOTS.some((root) => path.includes(root));
}

function decodedOrRaw(url: string): string {
	try {
		return decodeURIComponent(url);
	} catch {
		return url;
	}
}

// The one fact about this process an environment variable cannot forge, and
// therefore the one place it is derived. It used to be spelled twice —
// embedding/ and release/ each kept a copy so the upgrade path would not
// import the rest of the program — and the two were wrong together: a
// duplicated substring check is a duplicated bug. This module imports nothing,
// so release/ may depend on it without dragging anything in behind it.
export const RUNS_FROM_COMPILED_BINARY: boolean = runsFromEmbeddedFilesystem(
	import.meta.url,
);
