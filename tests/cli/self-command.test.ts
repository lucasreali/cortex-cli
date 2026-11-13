import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfCommand, stableBinaryPath } from "@/cli/self-command";
import { isShellSafeCommandWord } from "@/install/git-hooks";
import { currentBinaryPath } from "@/release/installer";

describe("selfCommand", () => {
	test("a compiled binary is one word", () => {
		expect(selfCommand(["embed", "--missing"], true)).toEqual({
			executable: currentBinaryPath(),
			args: ["embed", "--missing"],
		});
	});

	test("a source checkout runs the CLI entrypoint under bun", () => {
		expect(selfCommand(["git-hook"], false, "/x/main.ts")).toEqual({
			executable: currentBinaryPath(),
			args: ["/x/main.ts", "git-hook"],
		});
	});

	test("the entrypoint defaults to this CLI's main", () => {
		const command = selfCommand([], false);
		expect(command.args).toHaveLength(1);
		expect(command.args[0]).toEndWith("/src/cli/main.ts");
	});

	// A git hook pins these words into a shell script, so they have to survive
	// the allowlist on the machine the tests run on.
	test("every word it produces is safe to pin into a hook", () => {
		const command = selfCommand();
		for (const word of [command.executable, ...command.args]) {
			expect(isShellSafeCommandWord(word)).toBe(true);
		}
	});

	// The conversion belongs here, where the path is produced, rather than in
	// each place that has to quote it: git runs hooks through the sh it ships
	// on Windows too, and that shell reads a backslash as an escape.
	test("a Windows entrypoint is handed over with forward slashes", () => {
		const command = selfCommand(
			["git-hook"],
			false,
			"C:\\repo\\src\\cli\\main.ts",
		);
		expect(command.args[0]).toBe("C:/repo/src/cli/main.ts");
		expect(isShellSafeCommandWord(command.args[0] ?? "")).toBe(true);
	});
});

describe("stableBinaryPath", () => {
	test("prefers the PATH entry that resolves to this same binary", () => {
		const dir = mkdtempSync(join(tmpdir(), "cortex-self-"));
		try {
			const link = join(dir, "cortex");
			symlinkSync(currentBinaryPath(), link);
			expect(stableBinaryPath(() => link)).toBe(link);
			expect(stableBinaryPath(() => null)).toBe(currentBinaryPath());
			expect(stableBinaryPath(() => join(dir, "missing"))).toBe(
				currentBinaryPath(),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
