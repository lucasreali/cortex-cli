import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { greetingPid } from "@/embedding/daemon/client";
import { encodeDaemonHello } from "@/embedding/daemon/hello";
import { acquireDaemonLock, type DaemonLock } from "@/embedding/daemon/lock";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { stopDaemon } from "@/embedding/daemon/stop";
import { GEMMA_MODEL } from "@/embedding/model";

const tempDirs: string[] = [];

function makePaths(): DaemonPaths {
	const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-stop-"));
	tempDirs.push(directory);
	return daemonPathsFor(GEMMA_MODEL.modelId, directory, false);
}

function lockFor(paths: DaemonPaths, pid: number): DaemonLock {
	const lock = {
		pid,
		version: "0.0.1",
		modelId: GEMMA_MODEL.modelId,
		socketPath: paths.socketPath,
		startedAt: 0,
	};
	acquireDaemonLock(paths.lockPath, lock);
	return lock;
}

async function exitedProcessPid(): Promise<number> {
	const child = Bun.spawn(["bun", "-e", "process.exit(0)"]);
	await child.exited;
	return child.pid;
}

function sleeper() {
	return Bun.spawn(["bun", "-e", "setTimeout(() => {}, 30_000)"]);
}

afterAll(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("stopDaemon", () => {
	test("does nothing when no daemon ever registered", async () => {
		expect(await stopDaemon(makePaths())).toBe(false);
	});

	test("does nothing when the lock names a process that is gone", async () => {
		const paths = makePaths();
		const pid = await exitedProcessPid();
		lockFor(paths, pid);
		expect(await stopDaemon(paths, async () => pid)).toBe(false);
	});

	test("terminates the daemon the lock points at once its socket confirms it", async () => {
		const paths = makePaths();
		const child = sleeper();
		lockFor(paths, child.pid);
		try {
			expect(await stopDaemon(paths, async () => child.pid)).toBe(true);
			await child.exited;
			expect(child.signalCode).toBe("SIGTERM");
		} finally {
			child.kill("SIGKILL");
		}
	}, 15_000);

	// A lock left behind by a crash names a pid the system hands to whatever
	// starts next; nothing answering on the socket is the tell.
	test("leaves a process alone when nothing on the socket claims its pid", async () => {
		const paths = makePaths();
		const child = sleeper();
		lockFor(paths, child.pid);
		try {
			expect(await stopDaemon(paths)).toBe(false);
			expect(await stopDaemon(paths, async () => child.pid + 1)).toBe(false);
			expect(child.killed).toBe(false);
		} finally {
			child.kill("SIGKILL");
		}
	}, 15_000);
});

describe("greetingPid", () => {
	test("reads the pid a listening daemon announces", async () => {
		const paths = makePaths();
		const lock = lockFor(paths, 4242);
		const listener = Bun.listen({
			unix: paths.socketPath,
			socket: {
				open(socket) {
					socket.write(
						encodeDaemonHello({
							cortex: lock.version,
							protocol: 1,
							pid: 4242,
							modelId: lock.modelId,
						}),
					);
				},
				data() {},
			},
		});
		try {
			expect(await greetingPid(paths, lock)).toBe(4242);
		} finally {
			listener.stop(true);
		}
	});
});
