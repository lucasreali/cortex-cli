import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDaemonLock } from "@/embedding/daemon/lock";
import { type DaemonPaths, daemonPathsFor } from "@/embedding/daemon/paths";
import { stopDaemon } from "@/embedding/daemon/stop";
import { GEMMA_MODEL } from "@/embedding/model";

const tempDirs: string[] = [];

function makePaths(): DaemonPaths {
	const directory = mkdtempSync(join(tmpdir(), "cortex-daemon-stop-"));
	tempDirs.push(directory);
	return daemonPathsFor(GEMMA_MODEL.modelId, directory);
}

function lockFor(paths: DaemonPaths, pid: number): void {
	acquireDaemonLock(paths.lockPath, {
		pid,
		version: "0.0.1",
		modelId: GEMMA_MODEL.modelId,
		socketPath: paths.socketPath,
		startedAt: 0,
	});
}

async function exitedProcessPid(): Promise<number> {
	const child = Bun.spawn(["bun", "-e", "process.exit(0)"]);
	await child.exited;
	return child.pid;
}

afterAll(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("stopDaemon", () => {
	test("does nothing when no daemon ever registered", () => {
		expect(stopDaemon(makePaths())).toBe(false);
	});

	test("does nothing when the lock names a process that is gone", async () => {
		const paths = makePaths();
		lockFor(paths, await exitedProcessPid());
		expect(stopDaemon(paths)).toBe(false);
	});

	test("terminates the daemon the lock points at", async () => {
		const paths = makePaths();
		const child = Bun.spawn(["bun", "-e", "setTimeout(() => {}, 30_000)"]);
		lockFor(paths, child.pid);
		try {
			expect(stopDaemon(paths)).toBe(true);
			await child.exited;
			expect(child.signalCode).toBe("SIGTERM");
		} finally {
			child.kill("SIGKILL");
		}
	}, 15_000);
});
