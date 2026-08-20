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

const PROBE_TIMEOUT_MS = 10_000;
const STAGING_SUFFIX = ".partial";
const STAGING_PID = /\.(\d+)\.partial$/;

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

// The running executable cannot be written into (ETXTBSY), but renaming over
// it is safe: this process keeps the inode it started from. Staging next to
// the target keeps that rename on one filesystem, and the new binary has to
// prove it runs before the old one is given up.
export async function installBinary(installation: Installation): Promise<void> {
	discardOrphans(installation.targetPath);
	const staging = stagingPath(installation.targetPath);
	try {
		await writeStaging(staging, installation.binary);
		chmodSync(staging, 0o755);
		assertReportsVersion(staging, installation.version);
		renameSync(staging, installation.targetPath);
	} catch (error) {
		discard(staging);
		throw describe(error, installation.targetPath);
	}
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
// in the install directory forever. The pid in the name says whose it is, so a
// sweep can reclaim the abandoned ones without touching an upgrade still
// running beside this one.
function discardOrphans(targetPath: string): void {
	const directory = dirname(targetPath);
	const prefix = `${basename(targetPath)}.`;
	for (const name of entries(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(STAGING_SUFFIX)) continue;
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
	const pid = Number(STAGING_PID.exec(name)?.[1]);
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
