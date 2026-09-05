import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	daemonPathsFor,
	defaultDaemonDirectory,
} from "@/embedding/daemon/paths";

const originalDaemonDir = process.env.CORTEX_DAEMON_DIR;

afterEach(() => {
	if (originalDaemonDir === undefined) delete process.env.CORTEX_DAEMON_DIR;
	else process.env.CORTEX_DAEMON_DIR = originalDaemonDir;
});

describe("daemon paths", () => {
	test("derives socket, lock and log from a file-safe model id", () => {
		const paths = daemonPathsFor("embeddinggemma-300m-q8@256", "/tmp/d");
		expect(paths.directory).toBe("/tmp/d");
		expect(paths.socketPath).toBe("/tmp/d/embeddinggemma-300m-q8-256.sock");
		expect(paths.lockPath).toBe("/tmp/d/embeddinggemma-300m-q8-256.lock");
		expect(paths.logPath).toBe("/tmp/d/embeddinggemma-300m-q8-256.log");
	});

	test("default directory honors CORTEX_DAEMON_DIR", () => {
		process.env.CORTEX_DAEMON_DIR = "/tmp/custom-daemon-dir";
		expect(defaultDaemonDirectory()).toBe("/tmp/custom-daemon-dir");
		expect(daemonPathsFor("model@1").directory).toBe("/tmp/custom-daemon-dir");
	});

	test("default directory falls back to ~/.cortex/daemon", () => {
		delete process.env.CORTEX_DAEMON_DIR;
		expect(defaultDaemonDirectory()).toBe(join(homedir(), ".cortex", "daemon"));
	});

	// Windows has no socket file to place beside the lock: a named pipe is a
	// name in a namespace the kernel owns. The lock and the log stay files,
	// because those are what a second process reads to find the daemon at all.
	describe("on Windows", () => {
		process.env.USERNAME = "Ada Lovelace";
		const paths = daemonPathsFor("embeddinggemma-300m-q8@256", "/tmp/d", true);

		test("the socket becomes a named pipe", () => {
			expect(paths.socketPath).toStartWith("\\\\.\\pipe\\cortex-");
			expect(paths.socketPath).toEndWith("-embeddinggemma-300m-q8-256");
		});

		test("the lock and the log stay files in the daemon directory", () => {
			expect(paths.lockPath).toBe("/tmp/d/embeddinggemma-300m-q8-256.lock");
			expect(paths.logPath).toBe("/tmp/d/embeddinggemma-300m-q8-256.log");
		});

		// The pipe namespace is shared by every account on the machine, so two
		// users must not resolve to one name and be handed each other's daemon.
		test("the owner is part of the pipe name, spelled file-safe", () => {
			expect(paths.socketPath).toContain("-Ada-Lovelace-");
		});
	});
});
