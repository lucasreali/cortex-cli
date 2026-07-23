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
});
