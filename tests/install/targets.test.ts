import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServerSpec } from "@/install/server-spec";
import {
	ALL_TARGETS,
	type HarnessTarget,
	instructionFilesFor,
	resolveTargets,
} from "@/install/targets";

const SPEC: McpServerSpec = { command: "cortex", args: ["serve", "--mcp"] };

function fakeHome(...markers: string[]): string {
	const home = mkdtempSync(join(tmpdir(), "cortex-targets-"));
	for (const marker of markers) {
		mkdirSync(join(home, marker), { recursive: true });
	}
	return home;
}

function target(id: string): HarnessTarget {
	const found = ALL_TARGETS.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`missing target ${id}`);
	return found;
}

describe("detection", () => {
	test("each target detects its user config dir", () => {
		const home = fakeHome(".claude", ".codex", ".cursor", ".gemini");
		for (const candidate of ALL_TARGETS) {
			expect(candidate.detectInstalled(home)).toBe(true);
		}
	});

	test("nothing is detected in a bare home", () => {
		const home = fakeHome();
		for (const candidate of ALL_TARGETS) {
			expect(candidate.detectInstalled(home)).toBe(false);
		}
	});

	test("claude is also detected by a bare ~/.claude.json", async () => {
		const home = fakeHome();
		await Bun.write(join(home, ".claude.json"), "{}");
		expect(target("claude").detectInstalled(home)).toBe(true);
	});
});

describe("registration", () => {
	test("claude and cursor write stdio entries, gemini omits type", async () => {
		const home = fakeHome();
		for (const id of ["claude", "cursor", "gemini"] as const) {
			const outcome = await target(id).register(home, SPEC);
			expect(outcome.action).toBe("created");
			const config = (await Bun.file(outcome.path).json()) as {
				mcpServers: { cortex: Record<string, unknown> };
			};
			const entry = config.mcpServers.cortex;
			expect(entry.command).toBe("cortex");
			expect(entry.args).toEqual(["serve", "--mcp"]);
			expect(entry.type).toBe(id === "gemini" ? undefined : "stdio");
		}
	});

	test("config paths land where each harness reads them", () => {
		const home = "/home/user";
		expect(target("claude").configPath(home)).toBe("/home/user/.claude.json");
		expect(target("codex").configPath(home)).toBe(
			"/home/user/.codex/config.toml",
		);
		expect(target("cursor").configPath(home)).toBe(
			"/home/user/.cursor/mcp.json",
		);
		expect(target("gemini").configPath(home)).toBe(
			"/home/user/.gemini/settings.json",
		);
	});

	test("codex creates config.toml, keeps other tables, then reports unchanged", async () => {
		const home = fakeHome();
		const codex = target("codex");
		const created = await codex.register(home, SPEC);
		expect(created.action).toBe("created");

		await Bun.write(
			created.path,
			`model = "gpt-5"\n\n${await Bun.file(created.path).text()}`,
		);
		const unchanged = await codex.register(home, SPEC);
		expect(unchanged.action).toBe("unchanged");

		const updated = await codex.register(home, {
			command: "/new/cortex",
			args: SPEC.args,
		});
		expect(updated.action).toBe("updated");
		const text = await Bun.file(created.path).text();
		expect(text).toContain('model = "gpt-5"');
		expect(text).toContain('command = "/new/cortex"');
	});
});

describe("resolveTargets", () => {
	test("auto returns only detected targets", () => {
		const home = fakeHome(".claude", ".gemini");
		const resolution = resolveTargets("auto", home);
		if ("error" in resolution) throw new Error(resolution.error);
		expect(resolution.targets.map((t) => t.id)).toEqual(["claude", "gemini"]);
	});

	test("all returns every target regardless of detection", () => {
		const resolution = resolveTargets("all", fakeHome());
		if ("error" in resolution) throw new Error(resolution.error);
		expect(resolution.targets).toHaveLength(ALL_TARGETS.length);
	});

	test("a csv list resolves, trims, and dedupes", () => {
		const resolution = resolveTargets(" cursor, claude ,cursor,", fakeHome());
		if ("error" in resolution) throw new Error(resolution.error);
		expect(resolution.targets.map((t) => t.id)).toEqual(["cursor", "claude"]);
	});

	test("an unknown id is an error naming the known ids", () => {
		const resolution = resolveTargets("claude,copilot", fakeHome());
		if (!("error" in resolution)) throw new Error("expected an error");
		expect(resolution.error).toContain("copilot");
		expect(resolution.error).toContain("claude, codex, cursor, gemini");
	});
});

describe("instructionFilesFor", () => {
	test("maps detected harnesses to deduped instruction files", () => {
		const home = fakeHome(".claude", ".codex", ".cursor");
		expect(instructionFilesFor(home, fakeHome())).toEqual([
			"CLAUDE.md",
			"AGENTS.md",
		]);
	});

	test("an existing project file enrolls its harness without detection", async () => {
		const root = fakeHome();
		await Bun.write(join(root, "GEMINI.md"), "# Notes\n");
		expect(instructionFilesFor(fakeHome(), root)).toEqual(["GEMINI.md"]);
	});

	test("a bare machine and project yield nothing", () => {
		expect(instructionFilesFor(fakeHome(), fakeHome())).toEqual([]);
	});
});
