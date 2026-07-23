import { describe, expect, test } from "bun:test";
import { callTool, connect, makeTempDir, run } from "./harness";

describe("test harness", () => {
	test("run surfaces the failing command and its stderr", () => {
		const dir = makeTempDir("cortex-harness-");
		expect(() =>
			run(dir, "bun", "-e", "console.error('kaboom'); process.exit(3)"),
		).toThrow("kaboom");
	});

	test("callTool wraps protocol-level failures as errors", async () => {
		const client = await connect(makeTempDir("cortex-harness-"));
		await client.close();
		const result = await callTool(client, "search", { intent: "anything" });
		expect(result.isError).toBe(true);
		expect(result.payload).toBeNull();
		expect(result.message).toContain("Not connected");
	});
});
