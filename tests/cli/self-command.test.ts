import { describe, expect, test } from "bun:test";
import { selfCommand } from "@/cli/self-command";
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
});
