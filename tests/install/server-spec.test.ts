import { describe, expect, test } from "bun:test";
import { resolveServerSpec } from "@/install/server-spec";

describe("resolveServerSpec", () => {
	test("a compiled binary registers itself by absolute path", () => {
		const resolution = resolveServerSpec({
			compiled: true,
			binaryPath: "/home/user/.local/bin/cortex",
			onPath: null,
		});
		expect(resolution.spec).toEqual({
			command: "/home/user/.local/bin/cortex",
			args: ["serve", "--mcp"],
		});
		expect(resolution.warning).toBeNull();
	});

	test("a source checkout registers the PATH name without warning when found", () => {
		const resolution = resolveServerSpec({
			compiled: false,
			binaryPath: "/usr/bin/bun",
			onPath: "/home/user/.local/bin/cortex",
		});
		expect(resolution.spec.command).toBe("cortex");
		expect(resolution.warning).toBeNull();
	});

	test("a source checkout with nothing on PATH warns", () => {
		const resolution = resolveServerSpec({
			compiled: false,
			binaryPath: "/usr/bin/bun",
			onPath: null,
		});
		expect(resolution.spec.command).toBe("cortex");
		expect(resolution.warning).toContain("not on PATH");
	});
});
