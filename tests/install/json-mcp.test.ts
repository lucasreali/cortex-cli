import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type GuardedWrite, upsertJsonMcpServer } from "@/install/json-mcp";

const ENTRY = { type: "stdio", command: "cortex", args: ["serve", "--mcp"] };

function configPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "cortex-json-mcp-")),
		"nested",
		"mcp.json",
	);
}

describe("upsertJsonMcpServer", () => {
	test("creates the file and parent directory when missing", async () => {
		const path = configPath();
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome).toEqual({ path, action: "created" });
		expect(await Bun.file(path).json()).toEqual({
			mcpServers: { cortex: ENTRY },
		});
	});

	test("preserves sibling servers and unrelated keys", async () => {
		const path = configPath();
		const existing = {
			theme: "dark",
			mcpServers: { other: { command: "other" } },
		};
		await Bun.write(path, JSON.stringify(existing));
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		expect(await Bun.file(path).json()).toEqual({
			theme: "dark",
			mcpServers: { other: { command: "other" }, cortex: ENTRY },
		});
	});

	test("an identical entry is reported unchanged without rewriting", async () => {
		const path = configPath();
		const text = `{"mcpServers":{"cortex":${JSON.stringify(ENTRY)}}}`;
		await Bun.write(path, text);
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("unchanged");
		expect(await Bun.file(path).text()).toBe(text);
	});

	test("a stale entry is updated in place", async () => {
		const path = configPath();
		await Bun.write(
			path,
			JSON.stringify({ mcpServers: { cortex: { command: "/old/cortex" } } }),
		);
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		const parsed = (await Bun.file(path).json()) as {
			mcpServers: { cortex: unknown };
		};
		expect(parsed.mcpServers.cortex).toEqual(ENTRY);
	});

	test("an empty file is treated as an empty config", async () => {
		const path = configPath();
		await Bun.write(path, "");
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome.action).toBe("updated");
		expect(await Bun.file(path).json()).toEqual({
			mcpServers: { cortex: ENTRY },
		});
	});

	test("unparseable JSON is skipped and left untouched", async () => {
		const path = configPath();
		await Bun.write(path, "{not json");
		const outcome = await upsertJsonMcpServer(path, ENTRY);
		expect(outcome).toMatchObject({
			action: "skipped",
			reason: expect.stringContaining("not valid JSON"),
		});
		expect(await Bun.file(path).text()).toBe("{not json");
	});

	test("a non-object root is skipped", async () => {
		const path = configPath();
		await Bun.write(path, "[1, 2]");
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe("skipped");
	});

	test("a non-object mcpServers is skipped", async () => {
		const path = configPath();
		await Bun.write(path, '{"mcpServers": "oops"}');
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe("skipped");
	});
});

// M35: the upsert replaced the entry wholesale, so a user who had added
// `env` to suppress a behaviour lost it on the next `cortex install`, with no
// diff and no warning, and the behaviour came back.
describe("keys the user added to the cortex entry", () => {
	test("survive a re-registration", async () => {
		const path = configPath();
		await Bun.write(
			path,
			JSON.stringify({
				mcpServers: {
					cortex: {
						command: "/old/cortex",
						env: { CORTEX_NO_USEFULNESS: "1" },
					},
				},
			}),
		);
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe("updated");
		const parsed = (await Bun.file(path).json()) as {
			mcpServers: { cortex: unknown };
		};
		expect(parsed.mcpServers.cortex).toEqual({
			...ENTRY,
			env: { CORTEX_NO_USEFULNESS: "1" },
		});
	});

	test("make an otherwise-matching entry unchanged, not rewritten", async () => {
		const path = configPath();
		const text = JSON.stringify({
			mcpServers: { cortex: { ...ENTRY, env: { A: "1" } } },
		});
		await Bun.write(path, text);
		expect((await upsertJsonMcpServer(path, ENTRY)).action).toBe("unchanged");
		expect(await Bun.file(path).text()).toBe(text);
	});
});

// M34: ~/.claude.json holds per-project state, history and trust decisions and
// is rewritten continuously by the session running `cortex install`. rename is
// atomic, which says nothing about whether what it publishes is still current.
describe("a config another process is rewriting", () => {
	const lost: GuardedWrite = async () => false;

	test("is reported skipped rather than reverted", async () => {
		const path = configPath();
		const text = JSON.stringify({ theme: "dark", mcpServers: {} });
		await Bun.write(path, text);
		const outcome = await upsertJsonMcpServer(path, ENTRY, lost);
		expect(outcome).toMatchObject({
			action: "skipped",
			reason: expect.stringContaining("another process"),
		});
		expect(await Bun.file(path).text()).toBe(text);
	});

	test("is skipped rather than created over", async () => {
		const path = configPath();
		const outcome = await upsertJsonMcpServer(path, ENTRY, lost);
		expect(outcome.action).toBe("skipped");
		expect(await Bun.file(path).exists()).toBe(false);
	});

	test("is merged onto whatever the other writer left", async () => {
		const path = configPath();
		await Bun.write(path, JSON.stringify({ mcpServers: {} }));
		let attempts = 0;
		const raceOnce: GuardedWrite = async (target, content, expected) => {
			attempts += 1;
			if (attempts === 1) {
				await Bun.write(target, JSON.stringify({ theme: "dark" }));
				return false;
			}
			expect(expected).toContain("dark");
			await Bun.write(target, content);
			return true;
		};
		expect((await upsertJsonMcpServer(path, ENTRY, raceOnce)).action).toBe(
			"updated",
		);
		expect(await Bun.file(path).json()).toEqual({
			theme: "dark",
			mcpServers: { cortex: ENTRY },
		});
	});
});
