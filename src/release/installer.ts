import { chmodSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { errnoCode } from "@/support/errors";

const PROBE_TIMEOUT_MS = 10_000;

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
	const staging = `${installation.targetPath}.${process.pid}.partial`;
	try {
		await Bun.write(staging, installation.binary);
		chmodSync(staging, 0o755);
		assertReportsVersion(staging, installation.version);
		renameSync(staging, installation.targetPath);
	} catch (error) {
		discard(staging);
		throw describe(error, installation.targetPath);
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
