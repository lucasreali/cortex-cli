import {
	chmodSync,
	closeSync,
	readdirSync,
	realpathSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { createStagingFile, stagingPath } from "@/support/atomic-write";
import { errnoCode } from "@/support/errors";
import { RUNS_ON_WINDOWS } from "@/support/platform";
import { RUNS_FROM_COMPILED_BINARY } from "./target";

const PROBE_TIMEOUT_MS = 10_000;
const RETIRED_SUFFIX = ".old";

// Every file this module may leave beside the binary, and whose upgrade left
// it. The pid is what lets a sweep tell an abandoned file from one an upgrade
// running beside this one is still using.
const LEFTOVER = /\.(\d+)\.(partial|old)(\.exe)?$/;

export interface Installation {
	binary: Uint8Array;
	version: string;
	targetPath: string;
}

// process.execPath is the cortex binary itself once compiled; realpath keeps a
// symlinked cortex a symlink instead of replacing the link with 60 MB.
export function currentBinaryPath(): string {
	return realpathSync(process.execPath);
}

// Which file an upgrade may replace, or null when there is none — a source
// checkout, where process.execPath is the bun runtime and replacing it would be
// absurd. CORTEX_UPGRADE_TARGET_PATH is the test seam that gives the source
// checkout a file of its own to install over, so the order the orchestration
// runs in can be driven end to end. It follows CORTEX_RELEASE_BASE_URL's rule
// and for the same reason: an installed binary ignores it outright, because
// anything able to set an environment variable would otherwise choose what the
// download lands on.
export function upgradeTargetPath(
	compiled: boolean = RUNS_FROM_COMPILED_BINARY,
): string | null {
	if (compiled) return currentBinaryPath();
	const override = process.env.CORTEX_UPGRADE_TARGET_PATH;
	return override ? realpathSync(override) : null;
}

// The running executable cannot be written into (ETXTBSY), but renaming over
// it is safe: this process keeps the inode it started from. Staging next to
// the target keeps that rename on one filesystem, and the new binary has to
// prove it runs before the old one is given up.
export async function installBinary(
	installation: Installation,
	onWindows: boolean = RUNS_ON_WINDOWS,
): Promise<void> {
	discardOrphans(installation.targetPath);
	const staging = installerStagingPath(installation.targetPath, onWindows);
	try {
		await writeStaging(staging, installation.binary);
		chmodSync(staging, 0o755);
		assertReportsVersion(staging, installation.version);
		replaceBinary(staging, installation.targetPath, onWindows);
	} catch (error) {
		discard(staging);
		throw describe(error, installation.targetPath);
	}
}

// Windows refuses a rename *onto* a running image — the loader holds the
// destination open without FILE_SHARE_DELETE — but renaming that image out of
// the way is allowed, because a mapping follows the file and not its name. So
// the one atomic swap POSIX gets becomes two renames, undone as a pair if the
// second fails: a failure between them would leave the install directory with
// no cortex at all. Deleting what was retired is the part this process cannot
// finish — it is the program currently executing — and the next upgrade sweeps
// it. Exported because the platform that takes this branch is not the platform
// the suite runs on, and the undo is only reachable from here.
export function replaceBinary(
	staging: string,
	targetPath: string,
	onWindows: boolean,
): void {
	if (!onWindows) {
		renameSync(staging, targetPath);
		return;
	}
	const retired = `${targetPath}.${process.pid}${RETIRED_SUFFIX}`;
	renameSync(targetPath, retired);
	try {
		renameSync(staging, targetPath);
	} catch (error) {
		renameSync(retired, targetPath);
		throw error;
	}
	discard(retired);
}

// Windows launches a program by inspecting the image, but only for a path it
// will treat as one: the version probe below runs the staged file before
// anything is replaced, so on Windows the staging name keeps an .exe tail.
function installerStagingPath(targetPath: string, onWindows: boolean): string {
	const staging = stagingPath(targetPath);
	return onWindows ? `${staging}.exe` : staging;
}

// Exclusive creation, so a symlink planted at the guessable staging path is
// refused instead of followed — here that would chmod 0755 the link's target
// and then rename the link itself over cortex.
async function writeStaging(
	staging: string,
	binary: Uint8Array,
): Promise<void> {
	const handle = createStagingFile(staging);
	try {
		await Bun.write(Bun.file(handle), binary);
	} finally {
		closeSync(handle);
	}
}

// An upgrade killed between the download and the rename leaves its staging file
// in the install directory forever, and on Windows a finished one leaves the
// binary it retired. The pid in the name says whose it is, so a sweep can
// reclaim the abandoned ones without touching an upgrade still running beside
// this one.
function discardOrphans(targetPath: string): void {
	const directory = dirname(targetPath);
	const prefix = `${basename(targetPath)}.`;
	for (const name of entries(directory)) {
		if (!name.startsWith(prefix) || !LEFTOVER.test(name)) continue;
		if (stillRunning(name)) continue;
		discard(join(directory, name));
	}
}

function entries(directory: string): string[] {
	try {
		return readdirSync(directory);
	} catch {
		return [];
	}
}

// A pid belonging to another user answers EPERM rather than ESRCH, and a name
// that carries no pid at all is not ours to reclaim: only a process the kernel
// has never heard of is gone for certain.
function stillRunning(name: string): boolean {
	const pid = Number(LEFTOVER.exec(name)?.[1]);
	if (!pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errnoCode(error) !== "ESRCH";
	}
}

// An asset built for another platform does not fail, it refuses to start:
// posix_spawn throws ENOEXEC instead of returning an exit code.
function assertReportsVersion(path: string, version: string): void {
	if (reportedVersion(path) === version) return;
	throw new Error(
		`the downloaded binary does not run here: expected it to report ${version}`,
	);
}

function reportedVersion(path: string): string {
	try {
		const probe = Bun.spawnSync([path, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: PROBE_TIMEOUT_MS,
		});
		if (probe.exitCode !== 0) return "";
		return probe.stdout.toString().trim();
	} catch {
		return "";
	}
}

function discard(staging: string): void {
	try {
		unlinkSync(staging);
	} catch {
		return;
	}
}

function describe(error: unknown, targetPath: string): Error {
	const code = errnoCode(error);
	if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
		return new Error(
			`cannot replace ${targetPath}: ${dirname(targetPath)} is not writable — ` +
				"re-run the installer as a user who owns it, or install to a " +
				"directory you own with CORTEX_INSTALL_DIR",
		);
	}
	return error instanceof Error ? error : new Error(String(error));
}
