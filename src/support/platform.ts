// Whether this process runs on Windows, as a value rather than a check made
// three times over. Every consumer takes it as a default parameter instead of
// reading process.platform for itself: the branch a given host cannot reach is
// still a branch the suite has to drive, and a constant read inline is one no
// test can enter.
export const RUNS_ON_WINDOWS: boolean = process.platform === "win32";

// Bun serves every module inside a compiled binary from an embedded
// filesystem, and spells its root differently per platform: "/$bunfs/" on
// POSIX, and "B:\~BUN\root\" on Windows — which reaches import.meta.url as
// file:///B:/~BUN/root/. Matching only the POSIX spelling made a compiled
// Windows binary believe it was a source checkout, and that belief is what
// decides whether an environment variable may choose the origin cortex
// upgrades from and the program it executes. It also decides how the binary
// reaches its own hidden subcommands, so a wrong answer costs the worker, the
// daemon and the git hooks as well.
//
// A drive letter is not pinned: only Bun chooses it, and the marker is
// distinctive enough without one.
const EMBEDDED_FILESYSTEM_ROOTS = ["$bunfs", "/~BUN/"];

export function runsFromEmbeddedFilesystem(moduleUrl: string): boolean {
	return EMBEDDED_FILESYSTEM_ROOTS.some((root) => moduleUrl.includes(root));
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
