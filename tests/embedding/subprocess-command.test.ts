import { describe, expect, test } from "bun:test";
import {
	embedDaemonCommand,
	embedWorkerCommand,
	RUNS_FROM_COMPILED_BINARY,
} from "@/embedding/subprocess-command";

describe("subprocess commands", () => {
	test("a source checkout is not a compiled binary", () => {
		expect(RUNS_FROM_COMPILED_BINARY).toBe(false);
	});

	test("an explicit workerPath always wins", () => {
		for (const compiled of [false, true]) {
			expect(embedWorkerCommand("/tmp/fake-worker.ts", compiled)).toEqual({
				executable: process.execPath,
				argv: ["/tmp/fake-worker.ts"],
			});
		}
	});

	test("worker from source spawns the worker entrypoint", () => {
		const command = embedWorkerCommand(undefined, false);
		expect(command.executable).toBe(process.execPath);
		expect(command.argv).toHaveLength(1);
		expect(command.argv[0]).toEndWith("/src/embedding/worker.ts");
	});

	test("worker from a compiled binary re-invokes the CLI subcommand", () => {
		expect(embedWorkerCommand(undefined, true)).toEqual({
			executable: process.execPath,
			argv: ["embed-worker"],
		});
	});

	test("daemon from source spawns the daemon entrypoint with the model", () => {
		const command = embedDaemonCommand("model-x", false);
		expect(command.executable).toBe(process.execPath);
		expect(command.argv[0]).toEndWith("/src/embedding/daemon/main.ts");
		expect(command.argv[1]).toBe("model-x");
	});

	test("daemon from a compiled binary re-invokes the CLI subcommand", () => {
		expect(embedDaemonCommand("model-x", true)).toEqual({
			executable: process.execPath,
			argv: ["embed-daemon", "model-x"],
		});
	});
});
