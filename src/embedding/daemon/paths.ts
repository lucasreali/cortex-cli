import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userCortexDir } from "@/support/cortex-home";
import { RUNS_ON_WINDOWS } from "@/support/platform";

export interface DaemonPaths {
	directory: string;
	socketPath: string;
	lockPath: string;
	logPath: string;
}

// Windows has no socket file to place next to the lock: a named pipe is a name
// in a machine-wide namespace the kernel owns, created and removed with the
// process that listens on it. That namespace is shared by every account on the
// machine, so the owner's name is part of the pipe's — without it two users
// would race for one daemon, and the loser would be handed the other's.
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";

export function daemonPathsFor(
	modelId: string,
	directory: string = defaultDaemonDirectory(),
	onWindows: boolean = RUNS_ON_WINDOWS,
): DaemonPaths {
	const base = fileSafe(modelId);
	return {
		directory,
		socketPath: onWindows
			? `${WINDOWS_PIPE_PREFIX}cortex-${fileSafe(owner())}-${base}-${pipeToken(directory, base)}`
			: join(directory, `${base}.sock`),
		lockPath: join(directory, `${base}.lock`),
		logPath: join(directory, `${base}.log`),
	};
}

export function defaultDaemonDirectory(): string {
	return userCortexDir("daemon", process.env.CORTEX_DAEMON_DIR);
}

// A pipe name anyone can predict is a pipe anyone can create first: another
// account on the machine could listen under it and be sent every text this
// user embeds. The token lives in the user's own daemon directory, which other
// accounts cannot read, so only this user's processes know the name. The
// first process to need it writes it, exclusively, and every later one reads
// that same value.
function pipeToken(directory: string, base: string): string {
	const path = join(directory, `${base}.pipe-token`);
	const existing = readToken(path);
	if (existing) return existing;
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(path, randomBytes(16).toString("hex"), {
			flag: "wx",
			mode: 0o600,
		});
	} catch {}
	return readToken(path) ?? "shared";
}

function readToken(path: string): string | null {
	try {
		const token = readFileSync(path, "utf8").trim();
		return /^[0-9a-f]{32}$/.test(token) ? token : null;
	} catch {
		return null;
	}
}

// Windows sets USERNAME for every interactive and service account. Where it
// somehow is not set, one shared name is still better than no daemon: the
// handshake already refuses a peer serving another model or version.
function owner(): string {
	return process.env.USERNAME ?? "user";
}

function fileSafe(modelId: string): string {
	return modelId.replace(/[^\w.-]+/g, "-");
}
